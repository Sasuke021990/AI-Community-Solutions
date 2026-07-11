import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { openDatabase, createRepositories, Repositories, LmStudioClient, Strategy, SpaceStatus, RunStatus } from '@acs/core';
import { createIpcRouter } from './ipcRouter.js';
import { RunManager } from './RunManager.js';
import { SettingsStore } from './SettingsStore.js';
import { Channels } from '../shared/ipc.js';

describe('ipcRouter', () => {
  let repos: Repositories;
  let router: ReturnType<typeof createIpcRouter>;
  let settingsDir: string;
  let startRunCalls: { spaceId: string; problem: string }[];

  beforeEach(() => {
    const db = openDatabase(join(tmpdir(), `router-${randomUUID()}.sqlite`));
    repos = createRepositories(db);
    settingsDir = mkdtempSync(join(tmpdir(), 'acs-router-settings-'));
    const settingsStore = new SettingsStore(join(settingsDir, 'settings.json'));

    startRunCalls = [];
    // A fake RunManager isolates router tests from real run execution
    // (RunManager's own behavior is covered by RunManager.test.ts).
    const fakeRunManager = {
      startRun: async (spaceId: string, problem: string) => {
        startRunCalls.push({ spaceId, problem });
        return { runId: 'fake-run-id' };
      },
      stopRun: () => {
        throw new Error('Run is not currently active.');
      }
    } as unknown as RunManager;

    router = createIpcRouter({
      repos,
      getLmStudioClient: () => new LmStudioClient(),
      runManager: fakeRunManager,
      settingsStore
    });
  });

  afterEach(() => {
    rmSync(settingsDir, { recursive: true, force: true });
  });

  it('returns an INVALID_PAYLOAD envelope for a malformed request', async () => {
    const result = await router.handle(Channels.spacesCreate.name, { name: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_PAYLOAD');
      expect(result.error.details).toBeTruthy();
    }
  });

  it('returns an error envelope for an unknown channel', async () => {
    const result = await router.handle('not:a:real:channel', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/unknown channel/i);
  });

  it('creates and lists an MCP server via the mcp channels', async () => {
    const create = await router.handle(Channels.mcpCreate.name, { name: 'srv', transport: 'stdio', command: 'node' });
    expect(create.ok).toBe(true);

    const list = await router.handle(Channels.mcpList.name, {});
    expect(list.ok).toBe(true);
    if (list.ok) expect((list.data as unknown[]).length).toBe(1);
  });

  it('creates a Space, adds an agent, and publishes it end to end', async () => {
    const spaceRes = await router.handle(Channels.spacesCreate.name, {
      name: 'S', strategy: Strategy.RoundRobin, defaultModel: 'm', maxRounds: 5
    });
    expect(spaceRes.ok).toBe(true);
    const spaceId = (spaceRes as { ok: true; data: { id: string } }).data.id;

    const agentRes = await router.handle(Channels.agentsCreate.name, {
      spaceId, name: 'A', role: 'R', systemPrompt: 'sys', position: 0
    });
    expect(agentRes.ok).toBe(true);

    const publishRes = await router.handle(Channels.spacesPublish.name, { id: spaceId });
    expect(publishRes.ok).toBe(true);
    if (publishRes.ok) expect((publishRes.data as { success: boolean }).success).toBe(true);

    const getRes = await router.handle(Channels.spacesGet.name, { id: spaceId });
    if (getRes.ok) expect((getRes.data as { status: string }).status).toBe(SpaceStatus.Published);
  });

  it('spaces:list/get/create annotate hasActiveRun, and it flips true while a run is active', async () => {
    const createRes = await router.handle(Channels.spacesCreate.name, {
      name: 'S', strategy: Strategy.RoundRobin, defaultModel: 'm', maxRounds: 5
    });
    expect(createRes.ok).toBe(true);
    const spaceId = (createRes as { ok: true; data: { id: string; hasActiveRun: boolean } }).data.id;
    expect((createRes as { ok: true; data: { hasActiveRun: boolean } }).data.hasActiveRun).toBe(false);

    const getRes = await router.handle(Channels.spacesGet.name, { id: spaceId });
    if (getRes.ok) expect((getRes.data as { hasActiveRun: boolean }).hasActiveRun).toBe(false);

    const listRes = await router.handle(Channels.spacesList.name, {});
    if (listRes.ok) expect((listRes.data as { hasActiveRun: boolean }[])[0].hasActiveRun).toBe(false);

    // Simulate an active run directly against the repo (the router test uses
    // a fake RunManager, so runs:start here would not touch real run rows).
    repos.runs.create({
      id: randomUUID(), spaceId, problem: 'p', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now()
    });

    const getResRunning = await router.handle(Channels.spacesGet.name, { id: spaceId });
    if (getResRunning.ok) expect((getResRunning.data as { hasActiveRun: boolean }).hasActiveRun).toBe(true);
  });

  it('blocks delete/unpublish of a Space with an active run, surfaced as a plain error envelope', async () => {
    const spaceRes = await router.handle(Channels.spacesCreate.name, {
      name: 'S', strategy: Strategy.RoundRobin, defaultModel: 'm', maxRounds: 5
    });
    const spaceId = (spaceRes as { ok: true; data: { id: string } }).data.id;
    await router.handle(Channels.agentsCreate.name, { spaceId, name: 'A', role: 'R', systemPrompt: 'sys', position: 0 });
    await router.handle(Channels.spacesPublish.name, { id: spaceId });

    repos.runs.create({
      id: randomUUID(), spaceId, problem: 'p', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now()
    });

    const deleteRes = await router.handle(Channels.spacesDelete.name, { id: spaceId });
    expect(deleteRes.ok).toBe(false);
    if (!deleteRes.ok) expect(deleteRes.error.message).toMatch(/active/i);

    const unpublishRes = await router.handle(Channels.spacesUnpublish.name, { id: spaceId });
    expect(unpublishRes.ok).toBe(false);
    if (!unpublishRes.ok) expect(unpublishRes.error.message).toMatch(/active/i);
  });

  it('surfaces a repo business-rule error (published-lock) as a plain error envelope', async () => {
    const spaceRes = await router.handle(Channels.spacesCreate.name, {
      name: 'S', strategy: Strategy.RoundRobin, defaultModel: 'm', maxRounds: 5
    });
    const spaceId = (spaceRes as { ok: true; data: { id: string } }).data.id;
    await router.handle(Channels.agentsCreate.name, { spaceId, name: 'A', role: 'R', systemPrompt: 'sys', position: 0 });
    await router.handle(Channels.spacesPublish.name, { id: spaceId });

    const updateRes = await router.handle(Channels.spacesUpdate.name, {
      id: spaceId, name: 'renamed', strategy: Strategy.RoundRobin, defaultModel: 'm', maxRounds: 5
    });
    expect(updateRes.ok).toBe(false);
    if (!updateRes.ok) expect(updateRes.error.message).toMatch(/published/i);
  });

  it('delegates runs:start to the injected RunManager', async () => {
    const res = await router.handle(Channels.runsStart.name, { spaceId: 's1', problem: 'q' });
    expect(res.ok).toBe(true);
    expect(startRunCalls).toEqual([{ spaceId: 's1', problem: 'q' }]);
  });

  it('gets and updates settings', async () => {
    const initial = await router.handle(Channels.settingsGet.name, {});
    expect(initial.ok).toBe(true);

    const updated = await router.handle(Channels.settingsSet.name, { concurrencyCap: 5 });
    expect(updated.ok).toBe(true);
    if (updated.ok) expect((updated.data as { concurrencyCap: number }).concurrencyCap).toBe(5);
  });

  it('lists role templates with ready-to-copy generic prompts', async () => {
    const res = await router.handle(Channels.templatesList.name, {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      const templates = res.data as { systemPrompt: string }[];
      expect(templates.length).toBeGreaterThan(0);
      for (const t of templates) expect(t.systemPrompt).not.toMatch(/\{\{.*?\}\}/);
    }
  });

  it('lists agents by space', async () => {
    const spaceRes = await router.handle(Channels.spacesCreate.name, {
      name: 'S', strategy: Strategy.RoundRobin, defaultModel: 'm', maxRounds: 5
    });
    const spaceId = (spaceRes as { ok: true; data: { id: string } }).data.id;
    await router.handle(Channels.agentsCreate.name, { spaceId, name: 'A', role: 'R', systemPrompt: 'sys', position: 0 });

    const listRes = await router.handle(Channels.agentsListBySpace.name, { spaceId });
    expect(listRes.ok).toBe(true);
    if (listRes.ok) expect((listRes.data as { name: string }[]).map((a) => a.name)).toEqual(['A']);
  });
});
