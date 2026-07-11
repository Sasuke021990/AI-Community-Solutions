import { Run, Space, Agent } from '../domain/types.js';
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
import { randomUUID } from 'crypto';

export class RunOrchestrator {
  private abortController = new AbortController();
  private strategy: AgentStrategy;
  private state: ExecutionState;
  private stopped = false;

  constructor(
    run: Run,
    space: Space,
    agents: Agent[],
    mcpClients: McpClientWrapper[],
    private runRepo: RunRepo,
    private runEventRepo: RunEventRepo,
    lmStudioClient: LmStudioClient,
    concurrencyLimiter: ConcurrencyLimiter
  ) {
    this.strategy = this.createStrategy(space.strategy);

    this.state = {
      run,
      space,
      agents,
      mcpClients,
      lmStudioClient,
      concurrencyLimiter,
      messages: [],
      onEvent: (e) => {
        this.runEventRepo.append({
          id: randomUUID(),
          runId: run.id,
          type: e.type,
          agentId: e.agentId,
          payload: e.payload,
          at: Date.now()
        });
      },
      signal: this.abortController.signal
    };
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
      if (this.stopped) {
        // Manual stop: preserve the partial transcript, mark as stopped
        // (only this run — never touch other runs).
        this.runRepo.updateStatus(this.state.run.id, RunStatus.Stopped, Date.now());
      } else {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        this.runRepo.updateStatus(this.state.run.id, RunStatus.Failed, Date.now(), msg);
      }
    } finally {
      for (const mcp of this.state.mcpClients) {
        await mcp.close().catch(() => {});
      }
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
          { model: this.state.space.defaultModel, messages },
          () => {},
          this.abortController.signal
        ),
      this.abortController.signal
    );

    const m = res.message.content.match(/<final_answer>([\s\S]*?)<\/final_answer>/);
    return (m ? m[1] : res.message.content).trim();
  }

  /** Manually stop this run (and only this run). */
  public abort(): void {
    this.stopped = true;
    this.abortController.abort();
  }
}
