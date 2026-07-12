import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from './Database.js';
import { McpServerRepo, SpaceRepo, AgentRepo, RunRepo, RunEventRepo, WebhookRepo } from './repos/index.js';
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
  let webhookRepo: WebhookRepo;

  beforeEach(() => {
    dbPath = join(tmpdir(), `test-db-${randomUUID()}.sqlite`);
    dbWrapper = new Database(dbPath);
    const db = dbWrapper.getDb();
    mcpRepo = new McpServerRepo(db);
    spaceRepo = new SpaceRepo(db);
    agentRepo = new AgentRepo(db);
    runRepo = new RunRepo(db);
    runEventRepo = new RunEventRepo(db);
    webhookRepo = new WebhookRepo(db);
  });

  afterEach(() => {
    dbWrapper.close();
    try {
      rmSync(dbPath, { force: true });
    } catch {
      /* temp file may already be gone */
    }
  });

  it('migrations are idempotent on re-open', () => {
    dbWrapper.close();
    expect(() => {
      dbWrapper = new Database(dbPath);
    }).not.toThrow();
  });

  it('SpaceRepo round-trips temperature; missing defaults to undefined', () => {
    const spaceId1 = randomUUID();
    spaceRepo.create({
      id: spaceId1, name: 'T1', description: 'T1', strategy: Strategy.Orchestrator,
      defaultModel: 'm1', maxRounds: 5, status: SpaceStatus.Draft, createdAt: Date.now(), updatedAt: Date.now()
    });
    
    // Unset reads as undefined
    const s1 = spaceRepo.get(spaceId1)!;
    expect(s1.temperature).toBeUndefined();

    const spaceId2 = randomUUID();
    spaceRepo.create({
      id: spaceId2, name: 'T2', description: 'T2', strategy: Strategy.Orchestrator,
      defaultModel: 'm2', maxRounds: 5, temperature: 1.5, status: SpaceStatus.Draft, createdAt: Date.now(), updatedAt: Date.now()
    });
    
    // Set reads back correctly
    const s2 = spaceRepo.get(spaceId2)!;
    expect(s2.temperature).toBe(1.5);
    
    // Update saves it
    s2.temperature = 0.8;
    spaceRepo.update(s2);
    expect(spaceRepo.get(spaceId2)!.temperature).toBe(0.8);
  });

  it('updateTemperature works on a Published Space, where update() is blocked', () => {
    const spaceId = randomUUID();
    spaceRepo.create({
      id: spaceId, name: 'T3', description: 'T3', strategy: Strategy.Orchestrator,
      defaultModel: 'm', maxRounds: 5, temperature: 0.2, status: SpaceStatus.Draft, createdAt: Date.now(), updatedAt: Date.now()
    });
    agentRepo.create({
      id: randomUUID(), spaceId, name: 'Orch', role: 'Orch', systemPrompt: 'Sys', position: 1, isOrchestrator: true
    });
    const pub = spaceRepo.publish(spaceId);
    expect(pub.success).toBe(true);

    // The general update() path is rejected once Published...
    const space = spaceRepo.get(spaceId)!;
    space.temperature = 0.9;
    expect(() => spaceRepo.update(space)).toThrowError(/Cannot edit a published space/);

    // ...but the dedicated temperature path is not, since it's a runtime
    // tuning knob rather than locked structure.
    spaceRepo.updateTemperature(spaceId, 0.9);
    expect(spaceRepo.get(spaceId)!.temperature).toBe(0.9);

    // Clearing it back to undefined (NULL) also works.
    spaceRepo.updateTemperature(spaceId, undefined);
    expect(spaceRepo.get(spaceId)!.temperature).toBeUndefined();
  });

  it('updateTemperature throws for a nonexistent Space', () => {
    expect(() => spaceRepo.updateTemperature('nope', 0.5)).toThrowError(/not found/i);
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

    expect(() => agentRepo.create({
      id: randomUUID(), spaceId, name: 'C', role: 'C', systemPrompt: 'C', position: 2, isOrchestrator: false
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

  it('Webhook delete-block when referenced by published space', () => {
    const webhookId = randomUUID();
    webhookRepo.create({
      id: webhookId, name: 'WH1', description: '', method: 'GET', url: 'http://w', parameterized: false, enabled: true, createdAt: Date.now()
    });

    const spaceId = randomUUID();
    spaceRepo.create({
      id: spaceId, name: 'SpaceW', description: 'desc', strategy: Strategy.RoundRobin,
      defaultModel: 'm1', maxRounds: 5, status: SpaceStatus.Draft, createdAt: Date.now(), updatedAt: Date.now(),
      allowedWebhookIds: [webhookId]
    });

    // Draft space -> delete succeeds
    let del = webhookRepo.delete(webhookId);
    expect(del.success).toBe(true);

    // Recreate
    webhookRepo.create({ id: webhookId, name: 'WH1', description: '', method: 'GET', url: 'http://w', parameterized: false, enabled: true, createdAt: Date.now() });
    spaceRepo.create({
      id: spaceId + '2', name: 'SpaceW2', description: 'desc', strategy: Strategy.RoundRobin,
      defaultModel: 'm1', maxRounds: 5, status: SpaceStatus.Draft, createdAt: Date.now(), updatedAt: Date.now(),
      allowedWebhookIds: [webhookId]
    });
    agentRepo.create({
      id: randomUUID(), spaceId: spaceId + '2', name: 'A', role: 'A', systemPrompt: 'A', position: 1, isOrchestrator: false
    });
    spaceRepo.publish(spaceId + '2');

    // Published space -> delete blocked
    del = webhookRepo.delete(webhookId);
    expect(del.success).toBe(false);
    expect(del.affectedSpaces).toContain('SpaceW2');
  });

  it('WebhookRepo.update persists changes and SpaceRepo round-trips allowedWebhookIds', () => {
    const webhookId = randomUUID();
    webhookRepo.create({
      id: webhookId, name: 'WH1', description: 'orig', method: 'GET', url: 'http://w', parameterized: false, enabled: true, createdAt: Date.now()
    });

    webhookRepo.update({
      id: webhookId, name: 'WH1 renamed', description: 'updated', method: 'POST', url: 'http://w2',
      parameterized: true, headers: { Authorization: 'Bearer x' }, enabled: false, createdAt: Date.now()
    });

    const updated = webhookRepo.list().find((w) => w.id === webhookId);
    expect(updated).toMatchObject({
      name: 'WH1 renamed', description: 'updated', method: 'POST', url: 'http://w2',
      parameterized: true, headers: { Authorization: 'Bearer x' }, enabled: false
    });

    const spaceId = randomUUID();
    spaceRepo.create({
      id: spaceId, name: 'S', description: 'S', strategy: Strategy.RoundRobin, defaultModel: 'm1', maxRounds: 5,
      status: SpaceStatus.Draft, createdAt: Date.now(), updatedAt: Date.now(), allowedWebhookIds: [webhookId]
    });

    expect(spaceRepo.get(spaceId)?.allowedWebhookIds).toEqual([webhookId]);

    // update() can change the allowed set too (draft space, so this is allowed)
    spaceRepo.update({
      id: spaceId, name: 'S', description: 'S', strategy: Strategy.RoundRobin, defaultModel: 'm1', maxRounds: 5,
      status: SpaceStatus.Draft, createdAt: Date.now(), updatedAt: Date.now(), allowedWebhookIds: []
    });
    expect(spaceRepo.get(spaceId)?.allowedWebhookIds).toEqual([]);
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

  it('hasActiveRun reflects whether a running run exists for the space', () => {
    const spaceId = randomUUID();
    spaceRepo.create({
      id: spaceId, name: 'S', description: 'S', strategy: Strategy.RoundRobin, defaultModel: 'm1', maxRounds: 5,
      status: SpaceStatus.Draft, createdAt: Date.now(), updatedAt: Date.now()
    });
    expect(runRepo.hasActiveRun(spaceId)).toBe(false);

    const runId = randomUUID();
    runRepo.create({ id: runId, spaceId, problem: 'P', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now() });
    expect(runRepo.hasActiveRun(spaceId)).toBe(true);

    runRepo.updateStatus(runId, RunStatus.Completed, Date.now());
    expect(runRepo.hasActiveRun(spaceId)).toBe(false);
  });

  it('setPdfPath persists and is returned by get', () => {
    const spaceId = randomUUID();
    spaceRepo.create({
      id: spaceId, name: 'S', description: 'S', strategy: Strategy.RoundRobin, defaultModel: 'm1', maxRounds: 5,
      status: SpaceStatus.Draft, createdAt: Date.now(), updatedAt: Date.now()
    });
    const runId = randomUUID();
    runRepo.create({ id: runId, spaceId, problem: 'P', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now() });

    expect(runRepo.get(runId)?.pdfPath).toBeUndefined();
    runRepo.setPdfPath(runId, '/path/to/report.pdf');
    expect(runRepo.get(runId)?.pdfPath).toBe('/path/to/report.pdf');
  });

  it('delete and unpublish are blocked while a run is active on the space', () => {
    const spaceId = randomUUID();
    spaceRepo.create({
      id: spaceId, name: 'S', description: 'S', strategy: Strategy.RoundRobin, defaultModel: 'm1', maxRounds: 5,
      status: SpaceStatus.Draft, createdAt: Date.now(), updatedAt: Date.now()
    });
    agentRepo.create({ id: randomUUID(), spaceId, name: 'A', role: 'A', systemPrompt: 'A', position: 0, isOrchestrator: false });
    spaceRepo.publish(spaceId);

    const runId = randomUUID();
    runRepo.create({ id: runId, spaceId, problem: 'P', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now() });

    expect(() => spaceRepo.delete(spaceId)).toThrowError(/Cannot delete a Space while a run is active/);
    expect(() => spaceRepo.unpublish(spaceId)).toThrowError(/Cannot unpublish a Space while a run is active/);

    // Once the run finishes, both are allowed again.
    runRepo.updateStatus(runId, RunStatus.Completed, Date.now());
    expect(() => spaceRepo.unpublish(spaceId)).not.toThrow();
    expect(() => spaceRepo.delete(spaceId)).not.toThrow();
  });

  it('listBySpace returns a space\'s runs newest-first, excluding other spaces', () => {
    const spaceId = randomUUID();
    spaceRepo.create({
      id: spaceId, name: 'S', description: 'S', strategy: Strategy.RoundRobin, defaultModel: 'm1', maxRounds: 5,
      status: SpaceStatus.Draft, createdAt: Date.now(), updatedAt: Date.now()
    });
    const otherSpaceId = randomUUID();
    spaceRepo.create({
      id: otherSpaceId, name: 'Other', description: 'O', strategy: Strategy.RoundRobin, defaultModel: 'm1', maxRounds: 5,
      status: SpaceStatus.Draft, createdAt: Date.now(), updatedAt: Date.now()
    });

    const run1Id = randomUUID();
    runRepo.create({ id: run1Id, spaceId, problem: 'first', status: RunStatus.Running, roundsUsed: 0, startedAt: 1000 });
    runRepo.markInterrupted();
    const run2Id = randomUUID();
    runRepo.create({ id: run2Id, spaceId, problem: 'second', status: RunStatus.Running, roundsUsed: 0, startedAt: 2000 });
    runRepo.markInterrupted();
    runRepo.create({ id: randomUUID(), spaceId: otherSpaceId, problem: 'other', status: RunStatus.Running, roundsUsed: 0, startedAt: 1500 });

    const runs = runRepo.listBySpace(spaceId);
    expect(runs.map(r => r.id)).toEqual([run2Id, run1Id]);
  });

  it('run events auto-assign incrementing seq per run and list in order', () => {
    const spaceId = randomUUID();
    spaceRepo.create({
      id: spaceId, name: 'S', description: 'S', strategy: Strategy.RoundRobin, defaultModel: 'm1', maxRounds: 5,
      status: SpaceStatus.Draft, createdAt: Date.now(), updatedAt: Date.now()
    });
    const runId = randomUUID();
    runRepo.create({ id: runId, spaceId, problem: 'P', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now() });

    // seq is assigned by the repo, not the caller
    const e1 = runEventRepo.append({ id: randomUUID(), runId, type: RunEventType.RoundStart, payload: { round: 1 }, at: Date.now() });
    const e2 = runEventRepo.append({ id: randomUUID(), runId, type: RunEventType.AgentMessage, payload: { text: 'second' }, at: Date.now() });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);

    const events = runEventRepo.listByRun(runId);
    expect(events.map(e => e.seq)).toEqual([1, 2]);
    expect(events[0].type).toBe(RunEventType.RoundStart);
    expect(events[1].payload).toEqual({ text: 'second' });

    // seq is scoped per run: a separate run restarts at 1
    const spaceId2 = randomUUID();
    spaceRepo.create({
      id: spaceId2, name: 'S2', description: 'S2', strategy: Strategy.RoundRobin, defaultModel: 'm1', maxRounds: 5,
      status: SpaceStatus.Draft, createdAt: Date.now(), updatedAt: Date.now()
    });
    const runId2 = randomUUID();
    runRepo.create({ id: runId2, spaceId: spaceId2, problem: 'P2', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now() });
    const other = runEventRepo.append({ id: randomUUID(), runId: runId2, type: RunEventType.System, payload: {}, at: Date.now() });
    expect(other.seq).toBe(1);
  });

  it('createFromPreset builds Space and agents atomically and prevents duplicates', () => {
    const spaceId = randomUUID();
    const presetId = 'my-preset';
    
    const space = {
      id: spaceId, name: 'S', description: 'S', strategy: Strategy.RoundRobin, defaultModel: 'm1', maxRounds: 5,
      status: SpaceStatus.Draft, presetId, createdAt: Date.now(), updatedAt: Date.now()
    };
    const agents = [
      { id: randomUUID(), spaceId, name: 'A', role: 'A', systemPrompt: 'A', isOrchestrator: false, position: 0 },
      { id: randomUUID(), spaceId, name: 'B', role: 'B', systemPrompt: 'B', isOrchestrator: false, position: 1 }
    ];

    const created = spaceRepo.createFromPreset(space, agents);
    expect(created.presetId).toBe(presetId);
    
    const savedAgents = agentRepo.listBySpace(spaceId);
    expect(savedAgents.length).toBe(2);
    expect(savedAgents[0].name).toBe('A');
    expect(savedAgents[1].name).toBe('B');

    // Duplicate presetId fails and makes no partial writes
    const space2 = { ...space, id: randomUUID() };
    const agents2 = [{ id: randomUUID(), spaceId: space2.id, name: 'C', role: 'C', systemPrompt: 'C', isOrchestrator: false, position: 0 }];
    
    expect(() => spaceRepo.createFromPreset(space2, agents2)).toThrowError(/already exists/);
    expect(spaceRepo.get(space2.id)).toBeNull();
    expect(agentRepo.listBySpace(space2.id).length).toBe(0);
  });

  it('preset Space enforces structure locks on agents and space fields', () => {
    const spaceId = randomUUID();
    const presetId = 'locked-preset';
    
    const space = {
      id: spaceId, name: 'OrigName', description: 'OrigDesc', strategy: Strategy.RoundRobin, defaultModel: 'm1', maxRounds: 5,
      status: SpaceStatus.Draft, presetId, createdAt: Date.now(), updatedAt: Date.now()
    };
    const agentId = randomUUID();
    const agents = [
      { id: agentId, spaceId, name: 'OrigAgentName', role: 'Role', systemPrompt: 'Sys', isOrchestrator: false, position: 0 }
    ];

    spaceRepo.createFromPreset(space, agents);

    // Agent create/delete throws
    expect(() => agentRepo.create({ id: randomUUID(), spaceId, name: 'New', role: 'New', systemPrompt: 'New', isOrchestrator: false, position: 1 }))
      .toThrowError(/agent lineup is fixed/);
    expect(() => agentRepo.delete(agentId, spaceId)).toThrowError(/agent lineup is fixed/);

    // Agent update: model/prompt succeeds
    agentRepo.update({ id: agentId, spaceId, name: 'OrigAgentName', role: 'Role', systemPrompt: 'NewSys', modelId: 'new-model', isOrchestrator: false, position: 0 });
    let updatedAgent = agentRepo.listBySpace(spaceId)[0];
    expect(updatedAgent.systemPrompt).toBe('NewSys');
    expect(updatedAgent.modelId).toBe('new-model');

    // Agent update: structural change throws and blocks prompt change
    expect(() => agentRepo.update({ id: agentId, spaceId, name: 'ChangedName', role: 'Role', systemPrompt: 'EvenNewerSys', modelId: 'new-model', isOrchestrator: false, position: 0 }))
      .toThrowError(/are fixed by the Space's preset/);
    updatedAgent = agentRepo.listBySpace(spaceId)[0];
    expect(updatedAgent.name).toBe('OrigAgentName'); // Name unchanged
    expect(updatedAgent.systemPrompt).toBe('NewSys'); // Prompt unchanged (no partial success)

    // Space update: model/rounds succeeds
    spaceRepo.update({ id: spaceId, name: 'OrigName', description: 'OrigDesc', strategy: Strategy.RoundRobin, defaultModel: 'm2', maxRounds: 10, status: SpaceStatus.Draft, presetId, createdAt: Date.now(), updatedAt: Date.now() });
    const updatedSpace = spaceRepo.get(spaceId)!;
    expect(updatedSpace.defaultModel).toBe('m2');
    expect(updatedSpace.maxRounds).toBe(10);

    // Space update: name/desc/strategy throws
    expect(() => spaceRepo.update({ id: spaceId, name: 'NewName', description: 'OrigDesc', strategy: Strategy.RoundRobin, defaultModel: 'm2', maxRounds: 10, status: SpaceStatus.Draft, presetId, createdAt: Date.now(), updatedAt: Date.now() }))
      .toThrowError(/are fixed by its preset/);

    // Space publish/unpublish/delete still works
    spaceRepo.publish(spaceId);
    expect(spaceRepo.get(spaceId)!.status).toBe(SpaceStatus.Published);
    spaceRepo.unpublish(spaceId);
    expect(spaceRepo.get(spaceId)!.status).toBe(SpaceStatus.Draft);
    spaceRepo.delete(spaceId);
    expect(spaceRepo.get(spaceId)).toBeNull();
  });
});
