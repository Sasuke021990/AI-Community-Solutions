import { randomUUID } from 'crypto';
import {
  Repositories,
  LmStudioClient,
  ConcurrencyLimiter,
  McpClientWrapper,
  RunOrchestrator,
  RunStatus,
  SpaceStatus,
  PersistedRunEvent
} from '@acs/core';
import { RUN_EVENT_PUSH_CHANNEL, RUN_STATUS_PUSH_CHANNEL } from '../shared/ipc.js';

export type Broadcast = (channel: string, payload: unknown) => void;

export interface StartRunResult {
  runId: string;
}

/**
 * Owns the set of currently-active RunOrchestrator instances. runs:start
 * returns as soon as the run is created and preflight begins - the caller
 * follows progress via the live event/status push channels, not by
 * awaiting completion (a run can take minutes).
 */
export class RunManager {
  private active = new Map<string, RunOrchestrator>();

  constructor(
    private repos: Repositories,
    private getLmStudioClient: () => LmStudioClient,
    private getConcurrencyLimiter: () => ConcurrencyLimiter,
    private broadcast: Broadcast
  ) {}

  public async startRun(spaceId: string, problem: string): Promise<StartRunResult> {
    const space = this.repos.spaces.get(spaceId);
    if (!space) throw new Error('Space not found');
    if (space.status !== SpaceStatus.Published) {
      throw new Error('Space must be published before it can be run.');
    }

    const agents = this.repos.agents.listBySpace(spaceId);
    const mcpConfigs = this.repos.mcpServers
      .list()
      .filter((m) => m.enabled && (space.allowedMcpServerIds ?? []).includes(m.id));
    const mcpClients = mcpConfigs.map((c) => new McpClientWrapper(c));

    const webhooks = this.repos.webhooks
      .list()
      .filter((w) => w.enabled && (space.allowedWebhookIds ?? []).includes(w.id));

    const run = {
      id: randomUUID(),
      spaceId,
      problem,
      status: RunStatus.Running,
      roundsUsed: 0,
      startedAt: Date.now()
    };
    // Enforces the one-active-run-per-space rule; throws if the Space is busy.
    this.repos.runs.create(run);

    const engine = new RunOrchestrator(
      run,
      space,
      agents,
      mcpClients,
      webhooks,
      this.repos.runs,
      this.repos.runEvents,
      this.getLmStudioClient(),
      this.getConcurrencyLimiter()
    );
    this.active.set(run.id, engine);
    engine.onEvent((e: PersistedRunEvent) => this.broadcast(RUN_EVENT_PUSH_CHANNEL, e));

    engine
      .start()
      .catch(() => {
        // RunOrchestrator.start() already catches and persists failures;
        // this guards only against a bug in that catch itself.
      })
      .finally(() => {
        this.active.delete(run.id);
        const finalRun = this.repos.runs.get(run.id);
        this.broadcast(RUN_STATUS_PUSH_CHANNEL, finalRun);
      });

    return { runId: run.id };
  }

  public stopRun(runId: string): void {
    const engine = this.active.get(runId);
    if (!engine) throw new Error('Run is not currently active.');
    engine.abort();
  }

  public isActive(runId: string): boolean {
    return this.active.has(runId);
  }
}
