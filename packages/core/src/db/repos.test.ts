import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from './Database.js';
import { McpServerRepo, SpaceRepo, AgentRepo, RunRepo, RunEventRepo } from './repos/index.js';
import { Strategy, SpaceStatus, RunStatus, RunEventType } from '../domain/enums.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { rmSync } from 'fs';

describe('Database and Repositories Integration', () => {
  let dbPath: string;
  let dbWrapper: Database;
  let mcpRepo: McpServerRepo;
  let spaceRepo: SpaceRepo;
  let agentRepo: AgentRepo;
  let runRepo: RunRepo;
  let runEventRepo: RunEventRepo;

  beforeEach(() => {
    dbPath = join(tmpdir(), `test-db-${randomUUID()}.sqlite`);
    dbWrapper = new Database(dbPath);
    const db = dbWrapper.getDb();
    mcpRepo = new McpServerRepo(db);
    spaceRepo = new SpaceRepo(db);
    agentRepo = new AgentRepo(db);
    runRepo = new RunRepo(db);
    runEventRepo = new RunEventRepo(db);
  });

  afterEach(() => {
    dbWrapper.close();
    try {
      rmSync(dbPath, { force: true });
    } catch (e) {}
  });

  it('migrations are idempotent on re-open', () => {
    dbWrapper.close();
    expect(() => {
      dbWrapper = new Database(dbPath);
    }).not.toThrow();
  });

  it('publish validation matrix', () => {
    const spaceId = randomUUID();
    spaceRepo.create({
      id: spaceId, name: 'Test', description: 'Test',
      strategy: Strategy.Orchestrator, defaultModel: 'model1', maxRounds: 5,
      status: SpaceStatus.Draft, createdAt: Date.now(), updatedAt: Date.now()
    });

    // 1. No agents -> fails
    let pub = spaceRepo.publish(spaceId);
    expect(pub.success).toBe(false);
    expect(pub.issues[0].message).toContain('at least one agent');

    // 2. Wrong orchestrator count -> fails
    agentRepo.create({
      id: randomUUID(), spaceId, name: 'Agent1', role: 'Dev', systemPrompt: 'Sys', position: 1, isOrchestrator: false
    });
    pub = spaceRepo.publish(spaceId);
    expect(pub.success).toBe(false);
    expect(pub.issues[0].message).toContain('exactly one agent designated');

    // 3. Happy path -> succeeds
    const orchId = randomUUID();
    agentRepo.create({
      id: orchId, spaceId, name: 'Orch', role: 'Orch', systemPrompt: 'Sys', position: 2, isOrchestrator: true
    });
    pub = spaceRepo.publish(spaceId);
    expect(pub.success).toBe(true);
    
    // Status should be published
    expect(spaceRepo.get(spaceId)?.status).toBe(SpaceStatus.Published);
  });

  it('published-lock enforcement on Space and Agent edits', () => {
    const spaceId = randomUUID();
    spaceRepo.create({
      id: spaceId, name: 'Test', description: 'Test', strategy: Strategy.RoundRobin,
      defaultModel: 'm1', maxRounds: 5, status: SpaceStatus.Draft, createdAt: Date.now(), updatedAt: Date.now()
    });
    const agentId = randomUUID();
    agentRepo.create({
      id: agentId, spaceId, name: 'A', role: 'A', systemPrompt: 'A', position: 1, isOrchestrator: false
    });

    spaceRepo.publish(spaceId);

    expect(() => spaceRepo.update({
      id: spaceId, name: 'Test2', description: 'Test', strategy: Strategy.RoundRobin,
      defaultModel: 'm1', maxRounds: 5, status: SpaceStatus.Published, createdAt: Date.now(), updatedAt: Date.now()
    })).toThrowError(/Cannot edit a published space/);

    expect(() => agentRepo.update({
      id: agentId, spaceId, name: 'B', role: 'B', systemPrompt: 'B', position: 1, isOrchestrator: false
    })).toThrowError(/Cannot modify agents when Space is published/);
  });

  it('MCP delete-block when referenced by published space', () => {
    const mcpId = randomUUID();
    mcpRepo.create({
      id: mcpId, name: 'Server1', transport: 'stdio', enabled: true, createdAt: Date.now()
    });

    const spaceId = randomUUID();
    spaceRepo.create({
      id: spaceId, name: 'Space1', description: 'desc', strategy: Strategy.RoundRobin,
      defaultModel: 'm1', maxRounds: 5, status: SpaceStatus.Draft, createdAt: Date.now(), updatedAt: Date.now(),
      allowedMcpServerIds: [mcpId]
    });

    // Draft space -> delete succeeds
    let del = mcpRepo.delete(mcpId);
    expect(del.success).toBe(true);

    // Recreate
    mcpRepo.create({ id: mcpId, name: 'Server1', transport: 'stdio', enabled: true, createdAt: Date.now() });
    spaceRepo.create({
      id: spaceId + '2', name: 'Space2', description: 'desc', strategy: Strategy.RoundRobin,
      defaultModel: 'm1', maxRounds: 5, status: SpaceStatus.Draft, createdAt: Date.now(), updatedAt: Date.now(),
      allowedMcpServerIds: [mcpId]
    });
    agentRepo.create({
      id: randomUUID(), spaceId: spaceId + '2', name: 'A', role: 'A', systemPrompt: 'A', position: 1, isOrchestrator: false
    });
    spaceRepo.publish(spaceId + '2');

    // Published space -> delete blocked
    del = mcpRepo.delete(mcpId);
    expect(del.success).toBe(false);
    expect(del.affectedSpaces).toContain('Space2');
  });

  it('one-active-run rule and markInterrupted', () => {
    const spaceId = randomUUID();
    spaceRepo.create({
      id: spaceId, name: 'S', description: 'S', strategy: Strategy.RoundRobin, defaultModel: 'm1', maxRounds: 5,
      status: SpaceStatus.Draft, createdAt: Date.now(), updatedAt: Date.now()
    });

    const runId1 = randomUUID();
    runRepo.create({
      id: runId1, spaceId, problem: 'P', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now()
    });

    const runId2 = randomUUID();
    expect(() => runRepo.create({
      id: runId2, spaceId, problem: 'P2', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now()
    })).toThrowError(/A run is already active/);

    runRepo.markInterrupted();
    const run1 = runRepo.get(runId1);
    expect(run1?.status).toBe(RunStatus.Failed);
    expect(run1?.error).toBe('interrupted');

    // Can create a new run now
    expect(() => runRepo.create({
      id: runId2, spaceId, problem: 'P2', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now()
    })).not.toThrow();
  });
});
