import { Run, Space, Agent } from '../domain/types.js';
import { Strategy, RunStatus } from '../domain/enums.js';
import { RunRepo, RunEventRepo } from '../db/repos/index.js';
import { LmStudioClient, ConcurrencyLimiter } from '../llm/index.js';
import { McpClientWrapper } from '../mcp/McpClient.js';
import { AgentStrategy, OrchestratorStrategy, RoundRobinStrategy, DebateStrategy, ExecutionState } from './strategies/index.js';
import { randomUUID } from 'crypto';

export class RunOrchestrator {
  private abortController = new AbortController();
  private strategy: AgentStrategy;
  private state: ExecutionState;

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
      case Strategy.Orchestrator: return new OrchestratorStrategy();
      case Strategy.RoundRobin: return new RoundRobinStrategy();
      case Strategy.Debate: return new DebateStrategy();
      default: throw new Error(`Unknown strategy ${type}`);
    }
  }

  public async start(): Promise<void> {
    try {
      this.runRepo.updateStatus(this.state.run.id, RunStatus.Running);

      for (const mcp of this.state.mcpClients) {
        await mcp.connect();
      }

      while (this.state.run.roundsUsed < this.state.space.maxRounds) {
        if (this.abortController.signal.aborted) {
          throw new Error('Run aborted');
        }

        const result = await this.strategy.executeRound(this.state);
        this.runRepo.incrementRounds(this.state.run.id);
        this.state.run.roundsUsed++;

        if (result.finalAnswer) {
          this.runRepo.completeRun(this.state.run.id, result.finalAnswer);
          return;
        }
      }

      this.runRepo.updateStatus(this.state.run.id, RunStatus.Completed, Date.now(), 'Max rounds reached without final answer');
    } catch (e: unknown) {
      if (e instanceof Error) {
        this.runRepo.updateStatus(this.state.run.id, RunStatus.Failed, Date.now(), e.message);
      }
    } finally {
      for (const mcp of this.state.mcpClients) {
        await mcp.close().catch(() => {});
      }
    }
  }

  public abort(): void {
    this.abortController.abort();
    this.runRepo.markInterrupted();
  }
}
