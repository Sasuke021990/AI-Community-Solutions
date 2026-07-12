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

  it('registers an enabled webhook as a callable tool and routes calls to it', async () => {
    const lmClient = new LmStudioClient();
    vi.spyOn(lmClient, 'listModels').mockResolvedValue(['m']);

    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => 'FRESH NEWS DATA' });
    vi.stubGlobal('fetch', fetchSpy);

    let call = 0;
    const seenTools: unknown[] = [];
    vi.spyOn(lmClient, 'chat').mockImplementation(async (req) => {
      call++;
      seenTools.push(req.tools);
      if (call === 1) {
        return {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 't1', type: 'function', function: { name: 'webhook__News', arguments: JSON.stringify({ query: 'ai' }) } }
            ]
          }
        };
      }
      return { message: { role: 'assistant', content: '<final_answer>done</final_answer>' } };
    });

    const space = mkSpace({ strategy: Strategy.Orchestrator });
    const run = { id: 'r1', spaceId: 's1', problem: 'q', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now() };
    const agents = [{ id: 'a1', spaceId: 's1', name: 'A', role: 'A', systemPrompt: 'A', isOrchestrator: true, position: 1 }];
    const webhooks = [{
      id: 'w1', name: 'News', description: 'Fetches news', method: 'GET' as const, url: 'http://example.com/news',
      parameterized: true, enabled: true, createdAt: 0
    }];

    spaceRepo.create(space);
    runRepo.create(run);

    try {
      const engine = new RunOrchestrator(run, space, agents, [], webhooks, runRepo, eventRepo, lmClient, new ConcurrencyLimiter());
      await engine.start();

      // The tool was actually offered to the model, correctly namespaced and shaped.
      const offeredTools = seenTools[0] as { function: { name: string; parameters: { required?: string[] } } }[];
      const webhookTool = offeredTools.find((t) => t.function.name === 'webhook__News');
      expect(webhookTool).toBeDefined();
      expect(webhookTool!.function.parameters.required).toEqual(['query']);

      // The call was actually routed to the real HTTP fetch, with the query substituted.
      expect(fetchSpy).toHaveBeenCalledWith('http://example.com/news?query=ai', expect.objectContaining({ method: 'GET' }));

      // The fetched data reached the transcript as a tool result, and the run completed.
      const events = eventRepo.listByRun('r1');
      const toolResult = events.find((e) => e.type === 'tool_result');
      expect((toolResult?.payload as { result: string }).result).toBe('FRESH NEWS DATA');

      const updated = runRepo.get('r1');
      expect(updated?.status).toBe(RunStatus.Completed);
      expect(updated?.finalAnswer).toBe('done');
    } finally {
      vi.unstubAllGlobals();
    }
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

    const space = mkSpace({ strategy: Strategy.Orchestrator, defaultModel: 'm' });
    const run = { id: 'r1', spaceId: 's1', problem: 'q', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now() };
    const agents = [{ id: 'a1', spaceId: 's1', name: 'Researcher', role: 'R', systemPrompt: 'R', isOrchestrator: true, position: 1 }];

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

    const space = mkSpace({ strategy: Strategy.Orchestrator, maxRounds: 2 });
    const run = { id: 'r1', spaceId: 's1', problem: 'q', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now() };
    const agents = [{ id: 'a1', spaceId: 's1', name: 'A', role: 'A', systemPrompt: 'A', isOrchestrator: true, position: 1 }];

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

    const space = mkSpace({ strategy: Strategy.Orchestrator });
    const run = { id: 'r1', spaceId: 's1', problem: 'q', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now() };
    const agents = [{ id: 'a1', spaceId: 's1', name: 'A', role: 'A', systemPrompt: 'A', isOrchestrator: true, position: 1 }];
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

  it('streams live token deltas to onToken subscribers, tagged by agentId', async () => {
    const lmClient = new LmStudioClient();
    vi.spyOn(lmClient, 'listModels').mockResolvedValue(['m']);
    vi.spyOn(lmClient, 'chat').mockImplementation(async (_req, onToken) => {
      onToken('Hel');
      onToken('lo');
      return { message: { role: 'assistant', content: '<final_answer>hi</final_answer>' } };
    });

    const space = mkSpace({ strategy: Strategy.Orchestrator });
    const run = { id: 'r1', spaceId: 's1', problem: 'q', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now() };
    const agents = [{ id: 'a1', spaceId: 's1', name: 'A', role: 'A', systemPrompt: 'A', isOrchestrator: true, position: 1 }];
    spaceRepo.create(space);
    runRepo.create(run);

    const engine = new RunOrchestrator(run, space, agents, [], [], runRepo, eventRepo, lmClient, new ConcurrencyLimiter());
    const received: { agentId: string; token: string }[] = [];
    const unsub = engine.onToken((agentId, token) => received.push({ agentId, token }));

    await engine.start();
    unsub();

    expect(received).toEqual([
      { agentId: 'a1', token: 'Hel' },
      { agentId: 'a1', token: 'lo' }
    ]);
  });

  it('does not throw when no onToken subscriber is registered', async () => {
    const lmClient = new LmStudioClient();
    vi.spyOn(lmClient, 'listModels').mockResolvedValue(['m']);
    vi.spyOn(lmClient, 'chat').mockImplementation(async (_req, onToken) => {
      onToken('token with nobody listening');
      return { message: { role: 'assistant', content: '<final_answer>hi</final_answer>' } };
    });

    const space = mkSpace({ strategy: Strategy.Orchestrator });
    const run = { id: 'r1', spaceId: 's1', problem: 'q', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now() };
    const agents = [{ id: 'a1', spaceId: 's1', name: 'A', role: 'A', systemPrompt: 'A', isOrchestrator: true, position: 1 }];
    spaceRepo.create(space);
    runRepo.create(run);

    // No engine.onToken(...) subscription at all - callAgent's `state.onToken?.(...)`
    // must be a safe no-op, and the run must still complete normally.
    const engine = new RunOrchestrator(run, space, agents, [], [], runRepo, eventRepo, lmClient, new ConcurrencyLimiter());
    await engine.start();

    expect(runRepo.get('r1')?.status).toBe(RunStatus.Completed);
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
      if (sys.includes('synthesis assistant')) {
        return Promise.resolve({ message: { role: 'assistant', content: '<final_answer>salvaged</final_answer>' } });
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
    expect(runRepo.get('r1')?.status).toBe(RunStatus.Completed);
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

    const spaceA = mkSpace({ id: 'sa', strategy: Strategy.Orchestrator });
    const spaceB = mkSpace({ id: 'sb', strategy: Strategy.Orchestrator });
    spaceRepo.create(spaceA);
    spaceRepo.create(spaceB);

    const runA = { id: 'ra', spaceId: 'sa', problem: 'q', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now() };
    const runB = { id: 'rb', spaceId: 'sb', problem: 'q', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now() };
    runRepo.create(runA);
    runRepo.create(runB); // unrelated run in another space, still running

    const agents = [{ id: 'a1', spaceId: 'sa', name: 'A', role: 'A', systemPrompt: 'A', isOrchestrator: true, position: 1 }];
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

  it('salvages a partial transcript into a completed answer on model timeout', async () => {
    const lmClient = new LmStudioClient();
    vi.spyOn(lmClient, 'listModels').mockResolvedValue(['m']);

    let call = 0;
    vi.spyOn(lmClient, 'chat').mockImplementation(async () => {
      call++;
      if (call === 1) {
        return { message: { role: 'assistant', content: 'partial discussion...' } };
      }
      if (call === 2) {
        throw new Error('stall timeout: no tokens');
      }
      // synthesize safely happens
      return { message: { role: 'assistant', content: 'salvaged answer' } };
    });

    const space = mkSpace({ strategy: Strategy.Orchestrator });
    const run = { id: 'r1', spaceId: 's1', problem: 'q', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now() };
    const agents = [{ id: 'a1', spaceId: 's1', name: 'A', role: 'A', systemPrompt: 'A', isOrchestrator: true, position: 1 }];
    spaceRepo.create(space);
    runRepo.create(run);

    const engine = new RunOrchestrator(run, space, agents, [], [], runRepo, eventRepo, lmClient, new ConcurrencyLimiter(1));
    await engine.start();

    const finalRun = runRepo.get('r1');
    expect(finalRun?.status).toBe(RunStatus.Completed);
    expect(finalRun?.finalAnswer).toBe('salvaged answer');
  });

  it('threads temperature and frequency_penalty from space through RunOrchestrator to LmStudioClient', async () => {
    const lmClient = new LmStudioClient();
    vi.spyOn(lmClient, 'listModels').mockResolvedValue(['m']);

    let capturedReq: import('../llm/types.js').ChatRequest | undefined;
    vi.spyOn(lmClient, 'chat').mockImplementation(async (req) => {
      capturedReq = req;
      return { message: { role: 'assistant', content: '<final_answer>done</final_answer>' } };
    });

    const space = mkSpace({ temperature: 0.8 }); // explicitly set temperature
    const run = { id: 'r1', spaceId: 's1', problem: 'q', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now() };
    const agents = [{ id: 'a1', spaceId: 's1', name: 'A', role: 'A', systemPrompt: 'A', isOrchestrator: true, position: 1 }];
    spaceRepo.create(space);
    runRepo.create(run);

    const engine = new RunOrchestrator(run, space, agents, [], [], runRepo, eventRepo, lmClient, new ConcurrencyLimiter(1));
    await engine.start();

    expect(capturedReq).toBeDefined();
    expect(capturedReq.temperature).toBe(0.8);
    expect(capturedReq.frequency_penalty).toBe(0.3);
  });

  it('an orchestrator that answers without delegating is forced to delegate before the run completes', async () => {
    // Regression test for a real reported run: the orchestrator used its own
    // tools and answered directly, so every worker (5 of 6 hats) never ran.
    const lmClient = new LmStudioClient();
    vi.spyOn(lmClient, 'listModels').mockResolvedValue(['m']);

    let orchestratorCalls = 0;
    const workersCalled = new Set<string>();
    vi.spyOn(lmClient, 'chat').mockImplementation(async (req) => {
      const sys = typeof req.messages[0]?.content === 'string' ? req.messages[0].content : '';
      if (sys.includes('orchestrator')) {
        orchestratorCalls++;
        if (orchestratorCalls === 1) {
          // Tries to answer immediately, without delegating - must be rejected.
          return { message: { role: 'assistant', content: '<final_answer>I looked it up myself</final_answer>' } };
        }
        return { message: { role: 'assistant', content: '<task agent="Worker">do the research</task>' } };
      }
      workersCalled.add(sys);
      return { message: { role: 'assistant', content: '<final_answer>done via worker</final_answer>' } };
    });

    const space = mkSpace({ strategy: Strategy.Orchestrator, maxRounds: 10 });
    const run = { id: 'r1', spaceId: 's1', problem: 'q', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now() };
    const agents = [
      { id: 'o1', spaceId: 's1', name: 'Boss', role: 'Boss', systemPrompt: 'Boss', isOrchestrator: true, position: 0 },
      { id: 'w1', spaceId: 's1', name: 'Worker', role: 'Worker', systemPrompt: 'Worker', isOrchestrator: false, position: 1 }
    ];
    spaceRepo.create(space);
    runRepo.create(run);

    const engine = new RunOrchestrator(run, space, agents, [], [], runRepo, eventRepo, lmClient, new ConcurrencyLimiter(1));
    await engine.start();

    // The worker actually ran (delegation happened) before the run completed.
    expect(workersCalled.size).toBeGreaterThan(0);
    const updated = runRepo.get('r1');
    expect(updated?.status).toBe(RunStatus.Completed);
  });

  it('runs a structured Space to completion with every agent participating and no tags', async () => {
    const lmClient = new LmStudioClient();
    vi.spyOn(lmClient, 'listModels').mockResolvedValue(['m']);
    const ran = new Set<string>();
    vi.spyOn(lmClient, 'chat').mockImplementation(async (req) => {
      const name = req.messages[0].content.match(/named "(\w+)"/)?.[1] ?? '?';
      ran.add(name);
      return { message: { role: 'assistant', content: `text from ${name}` } }; // NB: never emits <final_answer>
    });

    const space = mkSpace({ strategy: Strategy.Structured, maxRounds: 1, presetId: undefined });
    const run = { id: 'r1', spaceId: 's1', problem: 'q', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now() };
    const agents = [
      { id: 'o', spaceId: 's1', name: 'Lead', role: 'Lead', systemPrompt: 'L', isOrchestrator: true, position: 0 },
      { id: 'w1', spaceId: 's1', name: 'Alpha', role: 'Alpha', systemPrompt: 'A', isOrchestrator: false, position: 1 },
      { id: 'w2', spaceId: 's1', name: 'Beta', role: 'Beta', systemPrompt: 'B', isOrchestrator: false, position: 2 }
    ];
    spaceRepo.create(space); runRepo.create(run);

    const engine = new RunOrchestrator(run, space, agents, [], [], runRepo, eventRepo, lmClient, new ConcurrencyLimiter(1));
    await engine.start();

    expect(ran.has('Alpha')).toBe(true);
    expect(ran.has('Beta')).toBe(true);   // no agent skipped
    expect(runRepo.get('r1')?.status).toBe(RunStatus.Completed);
    expect(runRepo.get('r1')?.finalAnswer).toBeTruthy(); // completed with no tag anywhere
  });
});
