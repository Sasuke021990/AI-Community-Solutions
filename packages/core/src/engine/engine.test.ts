import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RunOrchestrator } from './RunOrchestrator.js';
import { RunRepo, RunEventRepo, SpaceRepo } from '../db/repos/index.js';
import { Strategy, RunStatus, SpaceStatus } from '../domain/enums.js';
import { LmStudioClient, ConcurrencyLimiter } from '../llm/index.js';
import { Database } from '../db/Database.js';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { join } from 'path';

describe('RunOrchestrator', () => {
  let dbWrapper: Database;
  let runRepo: RunRepo;
  let eventRepo: RunEventRepo;
  let spaceRepo: SpaceRepo;

  beforeEach(() => {
    dbWrapper = new Database(join(tmpdir(), `test-${randomUUID()}.sqlite`));
    runRepo = new RunRepo(dbWrapper.getDb());
    eventRepo = new RunEventRepo(dbWrapper.getDb());
    spaceRepo = new SpaceRepo(dbWrapper.getDb());
  });

  const mkSpace = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 's1', name: 'S', description: 'S', strategy: Strategy.Orchestrator, defaultModel: 'm',
    maxRounds: 5, status: SpaceStatus.Published, createdAt: 0, updatedAt: 0, ...over
  });

  it('runs to completion when final_answer is provided', async () => {
    const lmClient = new LmStudioClient();
    vi.spyOn(lmClient, 'listModels').mockResolvedValue(['m']);
    vi.spyOn(lmClient, 'chat').mockResolvedValue({
      message: { role: 'assistant', content: '<final_answer>42</final_answer>' }
    });

    const space = mkSpace();
    const run = { id: 'r1', spaceId: 's1', problem: 'q', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now() };
    const agents = [{ id: 'a1', spaceId: 's1', name: 'A', role: 'A', systemPrompt: 'A', isOrchestrator: true, position: 1 }];

    spaceRepo.create(space);
    runRepo.create(run);

    const engine = new RunOrchestrator(run, space, agents, [], [], runRepo, eventRepo, lmClient, new ConcurrencyLimiter());
    await engine.start();

    const updated = runRepo.get('r1');
    expect(updated?.status).toBe(RunStatus.Completed);
    expect(updated?.finalAnswer).toBe('42');
    expect(updated?.roundsUsed).toBe(1);
  });

  it('fails fast (halts) when an agent model is not available in LM Studio', async () => {
    const lmClient = new LmStudioClient();
    vi.spyOn(lmClient, 'listModels').mockResolvedValue(['some-other-model']);
    const chatSpy = vi.spyOn(lmClient, 'chat');

    const space = mkSpace({ strategy: Strategy.RoundRobin, defaultModel: 'm' });
    const run = { id: 'r1', spaceId: 's1', problem: 'q', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now() };
    const agents = [{ id: 'a1', spaceId: 's1', name: 'Researcher', role: 'R', systemPrompt: 'R', isOrchestrator: false, position: 1 }];

    spaceRepo.create(space);
    runRepo.create(run);

    const engine = new RunOrchestrator(run, space, agents, [], [], runRepo, eventRepo, lmClient, new ConcurrencyLimiter());
    await engine.start();

    const updated = runRepo.get('r1');
    expect(updated?.status).toBe(RunStatus.Failed);
    expect(updated?.error).toContain('"m"');
    expect(updated?.error).toContain('Researcher');
    expect(chatSpy).not.toHaveBeenCalled(); // halted before any agent ran
  });

  it('synthesizes a best-effort answer when max rounds are reached', async () => {
    const lmClient = new LmStudioClient();
    vi.spyOn(lmClient, 'listModels').mockResolvedValue(['m']);
    vi.spyOn(lmClient, 'chat').mockImplementation(async (req) => {
      const sys = typeof req.messages[0]?.content === 'string' ? req.messages[0].content : '';
      const isSynthesis = sys.includes('synthesis assistant');
      return { message: { role: 'assistant', content: isSynthesis ? 'BEST EFFORT ANSWER' : 'still thinking...' } };
    });

    const space = mkSpace({ strategy: Strategy.RoundRobin, maxRounds: 2 });
    const run = { id: 'r1', spaceId: 's1', problem: 'q', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now() };
    const agents = [{ id: 'a1', spaceId: 's1', name: 'A', role: 'A', systemPrompt: 'A', isOrchestrator: false, position: 1 }];

    spaceRepo.create(space);
    runRepo.create(run);

    const engine = new RunOrchestrator(run, space, agents, [], [], runRepo, eventRepo, lmClient, new ConcurrencyLimiter());
    await engine.start();

    const updated = runRepo.get('r1');
    expect(updated?.status).toBe(RunStatus.Completed);
    expect(updated?.finalAnswer).toBe('BEST EFFORT ANSWER');
    expect(updated?.error).toBeUndefined();
    expect(updated?.roundsUsed).toBe(2);
  });

  it('streams live events to subscribers as the run progresses', async () => {
    const lmClient = new LmStudioClient();
    vi.spyOn(lmClient, 'listModels').mockResolvedValue(['m']);
    vi.spyOn(lmClient, 'chat').mockResolvedValue({
      message: { role: 'assistant', content: '<final_answer>hi</final_answer>' }
    });

    const space = mkSpace({ strategy: Strategy.RoundRobin });
    const run = { id: 'r1', spaceId: 's1', problem: 'q', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now() };
    const agents = [{ id: 'a1', spaceId: 's1', name: 'A', role: 'A', systemPrompt: 'A', isOrchestrator: false, position: 1 }];
    spaceRepo.create(space);
    runRepo.create(run);

    const engine = new RunOrchestrator(run, space, agents, [], [], runRepo, eventRepo, lmClient, new ConcurrencyLimiter());
    const received: string[] = [];
    const unsub = engine.onEvent((e) => received.push(e.type));

    await engine.start();
    unsub();

    // Live stream matches what was persisted, and is non-empty.
    expect(received.length).toBeGreaterThan(0);
    expect(received.length).toBe(eventRepo.listByRun('r1').length);
  });

  it('aborts other in-flight concurrent calls when one call in a Promise.all batch fails', async () => {
    const lmClient = new LmStudioClient();
    vi.spyOn(lmClient, 'listModels').mockResolvedValue(['m']);

    let workerBSawAbort = false;
    vi.spyOn(lmClient, 'chat').mockImplementation((req, _onToken, signal) => {
      const sys = typeof req.messages[0]?.content === 'string' ? req.messages[0].content : '';
      if (sys.includes('orchestrator')) {
        return Promise.resolve({
          message: { role: 'assistant', content: '<task agent="A">do a</task><task agent="B">do b</task>' }
        });
      }
      if (sys.includes('subtask: do a')) {
        // Worker A fails immediately, simulating a stall timeout on one
        // sibling call inside the orchestrator's concurrent dispatch.
        return Promise.reject(new Error('Model stall timeout: no tokens received for 60000ms.'));
      }
      // Worker B hangs until its shared abort signal fires - proving the
      // run-level failure actually cancels it instead of leaving it running
      // in the background against LM Studio.
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          workerBSawAbort = true;
          reject(new Error('aborted'));
          return;
        }
        signal?.addEventListener('abort', () => {
          workerBSawAbort = true;
          reject(new Error('aborted'));
        });
      });
    });

    const space = mkSpace({ strategy: Strategy.Orchestrator });
    const run = { id: 'r1', spaceId: 's1', problem: 'q', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now() };
    const agents = [
      { id: 'o', spaceId: 's1', name: 'Boss', role: 'Orchestrator', systemPrompt: 'orchestrator', isOrchestrator: true, position: 0 },
      { id: 'a', spaceId: 's1', name: 'A', role: 'A', systemPrompt: 'A', isOrchestrator: false, position: 1 },
      { id: 'b', spaceId: 's1', name: 'B', role: 'B', systemPrompt: 'B', isOrchestrator: false, position: 2 }
    ];

    spaceRepo.create(space);
    runRepo.create(run);

    const engine = new RunOrchestrator(run, space, agents, [], [], runRepo, eventRepo, lmClient, new ConcurrencyLimiter(4));
    await engine.start();

    expect(workerBSawAbort).toBe(true);
    expect(runRepo.get('r1')?.status).toBe(RunStatus.Failed);
  });

  it('manual stop marks only this run stopped and never touches other runs', async () => {
    const lmClient = new LmStudioClient();
    vi.spyOn(lmClient, 'listModels').mockResolvedValue(['m']);
    // chat hangs until aborted
    vi.spyOn(lmClient, 'chat').mockImplementation(
      (_req, _onToken, signal) =>
        new Promise((_resolve, reject) => {
          if (signal?.aborted) return reject(new Error('Request aborted.'));
          signal?.addEventListener('abort', () => reject(new Error('Request aborted.')));
        })
    );

    const spaceA = mkSpace({ id: 'sa', strategy: Strategy.RoundRobin });
    const spaceB = mkSpace({ id: 'sb', strategy: Strategy.RoundRobin });
    spaceRepo.create(spaceA);
    spaceRepo.create(spaceB);

    const runA = { id: 'ra', spaceId: 'sa', problem: 'q', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now() };
    const runB = { id: 'rb', spaceId: 'sb', problem: 'q', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now() };
    runRepo.create(runA);
    runRepo.create(runB); // unrelated run in another space, still running

    const agents = [{ id: 'a1', spaceId: 'sa', name: 'A', role: 'A', systemPrompt: 'A', isOrchestrator: false, position: 1 }];
    const engine = new RunOrchestrator(runA, spaceA, agents, [], [], runRepo, eventRepo, lmClient, new ConcurrencyLimiter());

    const p = engine.start();
    await new Promise((r) => setTimeout(r, 20)); // let it reach the hanging chat
    engine.abort();
    await p;

    expect(runRepo.get('ra')?.status).toBe(RunStatus.Stopped);
    expect(runRepo.get('rb')?.status).toBe(RunStatus.Running); // untouched
    // partial transcript preserved (a RoundStart event was recorded)
    expect(eventRepo.listByRun('ra').length).toBeGreaterThan(0);
  });
});
