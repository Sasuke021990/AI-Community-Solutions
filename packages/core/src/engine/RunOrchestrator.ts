import { Run, Space, Agent, RunEvent, WebhookConfig } from '../domain/types.js';
import { Strategy, RunStatus, RunEventType } from '../domain/enums.js';
import { RunRepo, RunEventRepo } from '../db/repos/index.js';
import { LmStudioClient, ConcurrencyLimiter, ChatMessage } from '../llm/index.js';
import { McpClientWrapper } from '../mcp/McpClient.js';
import {
  AgentStrategy,
  OrchestratorStrategy,
  RoundRobinStrategy,
  DebateStrategy,
  ExecutionState
} from './strategies/index.js';
import { fetchWebhook } from '../webhooks/WebhookClient.js';
import { randomUUID } from 'crypto';

/**
 * An event as persisted, delivered to live subscribers. This is exactly the
 * RunEvent the repo stored (including its assigned seq) - live subscribers
 * must see the same seq that a later `runEvents.listByRun()` replay would
 * return, so the renderer can merge/sort/dedupe live and fetched events by
 * a single consistent key.
 */
export type PersistedRunEvent = RunEvent;

export class RunOrchestrator {
  private abortController = new AbortController();
  private strategy: AgentStrategy;
  private state: ExecutionState;
  private stopped = false;
  private toolMap = new Map<string, { mcp: McpClientWrapper; originalName: string }>();
  private webhookMap = new Map<string, WebhookConfig>();
  private listeners = new Set<(e: PersistedRunEvent) => void>();
  /** Token subscribers — never persisted, high-frequency, ephemeral. */
  private tokenListeners = new Set<(agentId: string, token: string) => void>();

  constructor(
    run: Run,
    space: Space,
    agents: Agent[],
    mcpClients: McpClientWrapper[],
    private webhooks: WebhookConfig[],
    private runRepo: RunRepo,
    private runEventRepo: RunEventRepo,
    lmStudioClient: LmStudioClient,
    concurrencyLimiter: ConcurrencyLimiter
  ) {
    this.strategy = this.createStrategy(space.strategy);

    this.state = {
      run,
      space,
      temperature: space.temperature ?? 0.2,
      agents,
      mcpClients,
      lmStudioClient,
      concurrencyLimiter,
      messages: [],
      tools: [],
      callTool: (name, args) => this.callTool(name, args),
      onEvent: (e) => {
        // Persist before streaming: the transcript is the source of truth.
        // Broadcast the repo's return value (not our own draft object) so
        // live subscribers see the real assigned seq, not a seq-less copy.
        const stored = this.runEventRepo.append({
          id: randomUUID(),
          runId: run.id,
          type: e.type,
          agentId: e.agentId,
          payload: e.payload,
          at: Date.now()
        });
        for (const cb of this.listeners) {
          try {
            cb(stored);
          } catch {
            /* a subscriber error must not break the run */
          }
        }
      },
      onToken: (agentId, token) => {
        for (const cb of this.tokenListeners) {
          try { cb(agentId, token); } catch { /* subscriber error must not break the run */ }
        }
      },
      signal: this.abortController.signal
    };
  }

  /** Subscribe to live run events. Returns an unsubscribe function. */
  public onEvent(cb: (e: PersistedRunEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Subscribe to live token deltas. Returns an unsubscribe function. */
  public onToken(cb: (agentId: string, token: string) => void): () => void {
    this.tokenListeners.add(cb);
    return () => this.tokenListeners.delete(cb);
  }

  private createStrategy(type: Strategy): AgentStrategy {
    switch (type) {
      case Strategy.Orchestrator:
        return new OrchestratorStrategy();
      case Strategy.RoundRobin:
        return new RoundRobinStrategy();
      case Strategy.Debate:
        return new DebateStrategy();
      default:
        throw new Error(`Unknown strategy ${type}`);
    }
  }

  public async start(): Promise<void> {
    try {
      // Preflight (Decision #14): every agent's effective model must be
      // available in LM Studio, or the entire run halts before any work.
      await this.preflightModels();

      this.runRepo.updateStatus(this.state.run.id, RunStatus.Running);

      // Preflight: MCP servers must connect, else fail fast.
      for (const mcp of this.state.mcpClients) {
        await mcp.connect();
      }
      await this.buildToolRegistry();

      let finalAnswer: string | undefined;
      while (this.state.run.roundsUsed < this.state.space.maxRounds) {
        if (this.abortController.signal.aborted) throw new Error('Run stopped');

        const result = await this.strategy.executeRound(this.state);
        this.runRepo.incrementRounds(this.state.run.id);
        this.state.run.roundsUsed++;

        if (result.finalAnswer) {
          finalAnswer = result.finalAnswer;
          break;
        }
        if (result.halt) break;
      }

      if (finalAnswer === undefined) {
        // Max-round cap reached (Decision #7): synthesize a best-effort
        // answer from the transcript rather than finishing with nothing.
        if (this.abortController.signal.aborted) throw new Error('Run stopped');
        this.state.onEvent({
          type: RunEventType.System,
          payload: { note: 'Max rounds reached without a declared answer; synthesizing a best-effort answer.' }
        });
        finalAnswer = await this.synthesize();
      }

      this.runRepo.completeRun(this.state.run.id, finalAnswer);
    } catch (e: unknown) {
      // A failure from anywhere in the round (including one call inside a
      // concurrent Promise.all batch - orchestrator worker dispatch, debate
      // propose/critique) must not leave sibling calls running in the
      // background. Without this, a failed run keeps burning LM Studio
      // capacity - each orphaned call eventually hits its own independent
      // stall timeout and disconnects minutes later, well after the run
      // already shows Failed.
      this.abortController.abort();

      if (this.stopped) {
        // Manual stop: preserve the partial transcript, mark as stopped
        // (only this run — never touch other runs).
        this.runRepo.updateStatus(this.state.run.id, RunStatus.Stopped, Date.now());
      } else {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        const isTimeout = /timeout|stall/i.test(msg);
        const hasPartial = this.state.messages.length > 0;
        if (isTimeout && hasPartial) {
          // Salvage: the model hung, but we have material. Give the user an answer.
          try {
            const partial = await this.synthesizeSafely();
            if (partial) {
              this.state.onEvent({
                type: RunEventType.System,
                payload: { note: `Model timed out (${msg}); returning a best-effort answer from the partial discussion.` }
              });
              this.runRepo.completeRun(this.state.run.id, partial);
              return; // skip the failed path
            }
          } catch { /* fall through to failed */ }
        }
        this.runRepo.updateStatus(this.state.run.id, RunStatus.Failed, Date.now(), msg);
      }
    } finally {
      for (const mcp of this.state.mcpClients) {
        await mcp.close().catch(() => {});
      }
    }
  }

  /** Collects tools from all connected MCP servers, namespaced as server__tool. */
  private async buildToolRegistry(): Promise<void> {
    for (const mcp of this.state.mcpClients) {
      const { tools } = await mcp.listTools();
      const server = mcp.name.replace(/[^A-Za-z0-9_-]/g, '_');
      for (const t of tools) {
        const namespaced = `${server}__${t.name}`;
        this.toolMap.set(namespaced, { mcp, originalName: t.name });
        this.state.tools.push({
          type: 'function',
          function: { name: namespaced, description: t.description, parameters: t.inputSchema }
        });
      }
    }
    
    for (const w of this.webhooks) {
      if (!w.enabled) continue;
      const name = `webhook__${w.name.replace(/[^A-Za-z0-9_-]/g, '_')}`;
      this.webhookMap.set(name, w);
      this.state.tools.push({
        type: 'function',
        function: {
          name,
          description: w.description || `Fetch data from the "${w.name}" webhook.`,
          parameters: w.parameterized
            ? { type: 'object', properties: { query: { type: 'string', description: 'The search term or input to send.' } }, required: ['query'] }
            : { type: 'object', properties: {} }
        }
      });
    }
  }

  /** Routes a namespaced tool call to its server; failures become error strings. */
  private async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const wh = this.webhookMap.get(name);
    if (wh) {
      const query = typeof args.query === 'string' ? args.query : undefined;
      const result = await fetchWebhook(wh, query);
      return result.body;
    }

    const entry = this.toolMap.get(name);
    if (!entry) return `Error: tool "${name}" not found.`;
    try {
      const res = await entry.mcp.callTool(entry.originalName, args);
      const content = res.content as { type: string; text?: string }[] | undefined;
      if (!content) return '';
      return content.map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type} content]`)).join('\n');
    } catch (e: unknown) {
      return `Error calling tool "${name}": ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** Fail-fast check that every referenced model is loaded in LM Studio. */
  private async preflightModels(): Promise<void> {
    let available: Set<string>;
    try {
      available = new Set(await this.state.lmStudioClient.listModels(this.abortController.signal));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Preflight failed: could not list LM Studio models. ${msg}`);
    }

    for (const agent of this.state.agents) {
      const model = agent.modelId || this.state.space.defaultModel;
      if (!available.has(model)) {
        throw new Error(
          `Model "${model}" required by agent "${agent.name}" is not available in LM Studio. ` +
            `Load it in LM Studio and re-run. Halting the entire Space execution.`
        );
      }
    }
  }

  /** Best-effort final answer produced from the transcript at the round cap. */
  private async synthesize(): Promise<string> {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You are a synthesis assistant. Using the discussion transcript, produce the single best ' +
          'final answer to the problem. Reply with the answer only.'
      },
      { role: 'user', content: `Problem: ${this.state.run.problem}` },
      ...this.state.messages
    ];

    const res = await this.state.concurrencyLimiter.run(
      () =>
        this.state.lmStudioClient.chat(
          { model: this.state.space.defaultModel, messages, temperature: this.state.temperature },
          () => {},
          this.abortController.signal
        ),
      this.abortController.signal
    );

    const m = res.message.content.match(/<final_answer>([\s\S]*?)<\/final_answer>/);
    return (m ? m[1] : res.message.content).trim();
  }

  /** Wraps synthesize() to use a fresh signal so it can run after the main run aborted. */
  private async synthesizeSafely(): Promise<string | undefined> {
    const originalSignal = this.abortController.signal;
    const safeController = new AbortController();
    
    // Temporarily replace the abort controller for this specific call,
    // so it doesn't immediately fail due to the outer run being aborted.
    const originalLimiter = this.state.concurrencyLimiter;
    this.state.concurrencyLimiter = new ConcurrencyLimiter(1);
    this.abortController = safeController;
    
    try {
      return await this.synthesize();
    } catch {
      return undefined;
    } finally {
      this.abortController = { signal: originalSignal, abort: () => {} } as AbortController;
      this.state.concurrencyLimiter = originalLimiter;
    }
  }

  /** Manually stop this run (and only this run). */
  public abort(): void {
    this.stopped = true;
    this.abortController.abort();
  }
}
