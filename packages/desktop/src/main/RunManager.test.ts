import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import {
  openDatabase,
  createRepositories,
  Repositories,
  LmStudioClient,
  ConcurrencyLimiter,
  Strategy,
  SpaceStatus,
  RunStatus,
  Space
} from '@acs/core';
import { RunManager } from './RunManager.js';
import { RUN_EVENT_PUSH_CHANNEL, RUN_STATUS_PUSH_CHANNEL, RUN_TOKEN_PUSH_CHANNEL } from '../shared/ipc.js';

function mkSpace(over: Partial<Space> = {}): Space {
  return {
    id: 's1', name: 'S', description: '', strategy: Strategy.RoundRobin, defaultModel: 'm',
    maxRounds: 3, status: SpaceStatus.Published, createdAt: 0, updatedAt: 0, ...over
  };
}

describe('RunManager', () => {
  let repos: Repositories;
  let lmClient: LmStudioClient;
  let broadcasts: { channel: string; payload: unknown }[];

  let writePdfMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const db = openDatabase(join(tmpdir(), `runmanager-${randomUUID()}.sqlite`));
    repos = createRepositories(db);
    lmClient = new LmStudioClient();
    broadcasts = [];
    writePdfMock = vi.fn().mockResolvedValue(undefined);
  });

  function makeManager() {
    return new RunManager(repos, () => lmClient, () => new ConcurrencyLimiter(2), (channel, payload) =>
      broadcasts.push({ channel, payload }),
      () => '/tmp/reports',
      writePdfMock
    );
  }

  it('rejects starting a run on a draft (unpublished) Space', async () => {
    repos.spaces.create(mkSpace({ status: SpaceStatus.Draft }));
    const manager = makeManager();
    await expect(manager.startRun('s1', 'problem')).rejects.toThrow(/published/i);
  });

  it('rejects starting a run on a nonexistent Space', async () => {
    const manager = makeManager();
    await expect(manager.startRun('nope', 'problem')).rejects.toThrow(/not found/i);
  });

  it('starts a run, streams events, and broadcasts final status', async () => {
    vi.spyOn(lmClient, 'listModels').mockResolvedValue(['m']);
    vi.spyOn(lmClient, 'chat').mockResolvedValue({
      message: { role: 'assistant', content: '<final_answer>done</final_answer>' }
    });

    repos.spaces.create(mkSpace({ status: SpaceStatus.Draft }));
    repos.agents.create({ id: 'a1', spaceId: 's1', name: 'A', role: 'R', systemPrompt: 'sys', isOrchestrator: false, position: 0 });
    repos.spaces.publish('s1');

    const manager = makeManager();
    const { runId } = await manager.startRun('s1', 'solve it');
    expect(runId).toBeTruthy();

    // startRun returns before the engine finishes; wait for the final status push.
    await vi.waitFor(() => {
      expect(broadcasts.some((b) => b.channel === RUN_STATUS_PUSH_CHANNEL)).toBe(true);
    });

    expect(broadcasts.some((b) => b.channel === RUN_EVENT_PUSH_CHANNEL)).toBe(true);
    const run = repos.runs.get(runId);
    expect(run?.status).toBe(RunStatus.Completed);
    expect(run?.finalAnswer).toBe('done');
    expect(writePdfMock).toHaveBeenCalled();
    expect(run?.pdfPath).toBeDefined();
  });

  it('broadcasts live token deltas on RUN_TOKEN_PUSH_CHANNEL, tagged with the runId', async () => {
    vi.spyOn(lmClient, 'listModels').mockResolvedValue(['m']);
    vi.spyOn(lmClient, 'chat').mockImplementation(async (_req, onToken) => {
      onToken('Hel');
      onToken('lo');
      return { message: { role: 'assistant', content: '<final_answer>done</final_answer>' } };
    });

    repos.spaces.create(mkSpace({ status: SpaceStatus.Draft }));
    repos.agents.create({ id: 'a1', spaceId: 's1', name: 'A', role: 'R', systemPrompt: 'sys', isOrchestrator: false, position: 0 });
    repos.spaces.publish('s1');

    const manager = makeManager();
    const { runId } = await manager.startRun('s1', 'solve it');

    await vi.waitFor(() => {
      expect(broadcasts.some((b) => b.channel === RUN_STATUS_PUSH_CHANNEL)).toBe(true);
    });

    const tokenBroadcasts = broadcasts.filter((b) => b.channel === RUN_TOKEN_PUSH_CHANNEL);
    expect(tokenBroadcasts.map((b) => b.payload)).toEqual([
      { runId, agentId: 'a1', token: 'Hel' },
      { runId, agentId: 'a1', token: 'lo' }
    ]);
  });

  it('swallows PDF generation failures so the run remains completed', async () => {
    vi.spyOn(lmClient, 'listModels').mockResolvedValue(['m']);
    vi.spyOn(lmClient, 'chat').mockResolvedValue({
      message: { role: 'assistant', content: '<final_answer>done</final_answer>' }
    });

    repos.spaces.create(mkSpace({ status: SpaceStatus.Draft }));
    repos.agents.create({ id: 'a1', spaceId: 's1', name: 'A', role: 'R', systemPrompt: 'sys', isOrchestrator: false, position: 0 });
    repos.spaces.publish('s1');

    writePdfMock.mockRejectedValue(new Error('PDF engine crashed'));

    const manager = makeManager();
    const { runId } = await manager.startRun('s1', 'solve it');

    await vi.waitFor(() => {
      expect(broadcasts.some((b) => b.channel === RUN_STATUS_PUSH_CHANNEL)).toBe(true);
    });

    const run = repos.runs.get(runId);
    expect(run?.status).toBe(RunStatus.Completed);
    expect(run?.pdfPath).toBeUndefined(); // It failed, so no path was set
    
    // C2: A system event was emitted for the PDF failure
    const pdfEvents = broadcasts.filter((b) => b.channel === RUN_EVENT_PUSH_CHANNEL && (b.payload as { type: string }).type === 'system');
    expect(pdfEvents.some((b) => ((b.payload as { payload: { note: string } }).payload.note || '').includes('Report generation failed'))).toBe(true);
  });

  it('enforces one active run per Space at the manager level (bubbles up from RunRepo)', async () => {
    vi.spyOn(lmClient, 'listModels').mockResolvedValue(['m']);
    // chat() hangs so the first run stays active.
    vi.spyOn(lmClient, 'chat').mockImplementation(
      (_r, _t, signal) =>
        new Promise((_res, rej) => {
          signal?.addEventListener('abort', () => rej(new Error('aborted')));
        })
    );

    repos.spaces.create(mkSpace({ status: SpaceStatus.Draft }));
    repos.agents.create({ id: 'a1', spaceId: 's1', name: 'A', role: 'R', systemPrompt: 'sys', isOrchestrator: false, position: 0 });
    repos.spaces.publish('s1');

    const manager = makeManager();
    const { runId } = await manager.startRun('s1', 'first');
    await expect(manager.startRun('s1', 'second')).rejects.toThrow(/already active/i);

    manager.stopRun(runId);
  });

  it('stopRun throws for a runId that is not active', () => {
    const manager = makeManager();
    expect(() => manager.stopRun('not-active')).toThrow(/not currently active/i);
  });
});
