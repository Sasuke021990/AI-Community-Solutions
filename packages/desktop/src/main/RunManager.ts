import { randomUUID } from 'crypto';
import {
  Repositories,
  LmStudioClient,
  ConcurrencyLimiter,
  McpClientWrapper,
  RunOrchestrator,
  RunStatus,
  SpaceStatus,
  RunEventType,
  PersistedRunEvent,
  RunReportHtml,
  renderRunReport,
  generateNarrative
} from '@acs/core';
import { RUN_EVENT_PUSH_CHANNEL, RUN_STATUS_PUSH_CHANNEL, RUN_TOKEN_PUSH_CHANNEL, RUN_REPORT_GENERATION_CHANNEL } from '../shared/ipc.js';
import { join } from 'path';

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
    private broadcast: Broadcast,
    private getReportsFolder: () => string,
    private writePdf: (report: RunReportHtml, outPath: string, spaceName: string, dateStr: string) => Promise<void>,
    private getNarrativeModel: () => string
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
    engine.onToken((agentId, token) => this.broadcast(RUN_TOKEN_PUSH_CHANNEL, { runId: run.id, agentId, token }));

    engine
      .start()
      .catch(() => {
        // RunOrchestrator.start() already catches and persists failures;
        // this guards only against a bug in that catch itself.
      })
      .finally(async () => {
        this.active.delete(run.id);
        const finalRun = this.repos.runs.get(run.id);
        if (finalRun) {
          // The conversation itself is already done and persisted at this
          // point (RunOrchestrator.start() already wrote the terminal status
          // + finalAnswer) - broadcast it now, before the narrative/PDF work
          // below, so the UI reflects completion immediately instead of
          // staying stuck on "running" for the entire report-generation
          // window (which can take minutes with a narrative model).
          this.broadcast(RUN_STATUS_PUSH_CHANNEL, finalRun);
          try {
            this.broadcast(RUN_REPORT_GENERATION_CHANNEL, { runId: finalRun.id, isGenerating: true });
            const space = this.repos.spaces.get(finalRun.spaceId)!;
            const agents = this.repos.agents.listBySpace(finalRun.spaceId);
            const events = this.repos.runEvents.listByRun(finalRun.id);
            
            let narrative;
            const narrativeModel = this.getNarrativeModel();
            if (narrativeModel !== 'None (Raw Transcript)') {
              // A narrative failure must degrade to the plain layout, never
              // cost the user the whole PDF - so it may not reach the outer
              // catch (which skips writePdf entirely).
              narrative = await generateNarrative(
                { run: finalRun, space, agents, events },
                this.getLmStudioClient(),
                narrativeModel
              ).catch(() => undefined);
            }

            const report = renderRunReport({ run: finalRun, space, agents, events, narrative });
            const file = join(this.getReportsFolder(), buildPdfFilename(space.name, finalRun));
            const dateStr = new Date(finalRun.finishedAt ?? Date.now()).toLocaleString();
            await this.writePdf(report, file, finalRun.problem, dateStr);
            this.repos.runs.setPdfPath(finalRun.id, file);
          } catch (e) {
            // Log only - a PDF failure must never turn a finished run into a failure.
            console.error('PDF generation failed:', e);
            const msg = e instanceof Error ? e.message : String(e);
            const event = this.repos.runEvents.append({
              id: randomUUID(),
              runId: finalRun.id,
              type: RunEventType.System,
              payload: { note: `Report generation failed: ${msg}` },
              at: Date.now()
            });
            this.broadcast(RUN_EVENT_PUSH_CHANNEL, event);
          } finally {
            this.broadcast(RUN_REPORT_GENERATION_CHANNEL, { runId: finalRun.id, isGenerating: false });
          }
        }
        this.broadcast(RUN_STATUS_PUSH_CHANNEL, this.repos.runs.get(run.id));
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

function buildPdfFilename(spaceName: string, run: { id: string, startedAt: number, finishedAt?: number }): string {
  const slug = spaceName.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '');
  const d = new Date(run.finishedAt ?? run.startedAt);
  const YYYY = d.getFullYear();
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const DD = String(d.getDate()).padStart(2, '0');
  const HH = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${slug}-${run.id.slice(0, 8)}-${YYYY}${MM}${DD}-${HH}${mm}${ss}.pdf`;
}
