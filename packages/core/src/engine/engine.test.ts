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

  it('runs to completion when final_answer is provided', async () => {
    const lmClient = new LmStudioClient();
    vi.spyOn(lmClient, 'chat').mockResolvedValue({
      message: { role: 'assistant', content: '<final_answer>42</final_answer>' }
    });

    const run = { id: 'r1', spaceId: 's1', problem: 'q', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now() };
    const space = { id: 's1', name: 'S', description: 'S', strategy: Strategy.Orchestrator, defaultModel: 'm', maxRounds: 5, status: SpaceStatus.Published, createdAt: 0, updatedAt: 0 };
    const agents = [{ id: 'a1', spaceId: 's1', name: 'A', role: 'A', systemPrompt: 'A', isOrchestrator: true, position: 1 }];

    spaceRepo.create(space);
    runRepo.create(run);

    const engine = new RunOrchestrator(run, space, agents, [], runRepo, eventRepo, lmClient, new ConcurrencyLimiter());
    
    await engine.start();

    const updatedRun = runRepo.get('r1');
    expect(updatedRun?.status).toBe(RunStatus.Completed);
    expect(updatedRun?.finalAnswer).toBe('42');
    expect(updatedRun?.roundsUsed).toBe(1);
  });
});
