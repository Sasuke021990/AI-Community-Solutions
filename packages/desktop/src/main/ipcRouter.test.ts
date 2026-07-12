import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
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
      settingsStore,
      openPath: async (p) => p.includes('error') ? 'failed to open' : '',
      showInFolder: () => {}
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

  it('models:list uses the persisted client by default, but a baseUrl override when given', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: 'm1' }] }) });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const noOverride = await router.handle(Channels.modelsList.name, {});
      expect(noOverride.ok).toBe(true);
      expect(fetchSpy).toHaveBeenLastCalledWith('http://localhost:1234/v1/models', expect.anything());

      const withOverride = await router.handle(Channels.modelsList.name, { baseUrl: 'http://127.0.0.1:9999/v1' });
      expect(withOverride.ok).toBe(true);
      expect(fetchSpy).toHaveBeenLastCalledWith('http://127.0.0.1:9999/v1/models', expect.anything());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('creates and lists an MCP server via the mcp channels', async () => {
    const create = await router.handle(Channels.mcpCreate.name, { name: 'srv', transport: 'stdio', command: 'node' });
    expect(create.ok).toBe(true);

    const list = await router.handle(Channels.mcpList.name, {});
    expect(list.ok).toBe(true);
    if (list.ok) expect((list.data as unknown[]).length).toBe(1);
  });

  it('creates, lists, updates, and deletes a webhook via the webhooks channels', async () => {
    const create = await router.handle(Channels.webhooksCreate.name, {
      name: 'News', method: 'GET', url: 'http://example.com/news', parameterized: false
    });
    expect(create.ok).toBe(true);
    const webhookId = (create as { ok: true; data: { id: string } }).data.id;

    const list = await router.handle(Channels.webhooksList.name, {});
    expect(list.ok).toBe(true);
    if (list.ok) expect((list.data as unknown[]).length).toBe(1);

    const update = await router.handle(Channels.webhooksUpdate.name, {
      id: webhookId, name: 'News v2', method: 'GET', url: 'http://example.com/news', parameterized: false, enabled: false
    });
    expect(update.ok).toBe(true);
    const listAfterUpdate = await router.handle(Channels.webhooksList.name, {});
    if (listAfterUpdate.ok) {
      const updated = (listAfterUpdate.data as { name: string; enabled: boolean }[])[0];
      expect(updated.name).toBe('News v2');
      expect(updated.enabled).toBe(false);
    }

    const del = await router.handle(Channels.webhooksDelete.name, { id: webhookId });
    expect(del.ok).toBe(true);
    if (del.ok) expect((del.data as { success: boolean }).success).toBe(true);
  });

  it('webhooks:update on an unknown id returns an error envelope', async () => {
    const res = await router.handle(Channels.webhooksUpdate.name, {
      id: 'nope', name: 'X', method: 'GET', url: 'http://example.com', parameterized: false
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/not found/i);
  });

  it('blocks deleting a webhook referenced by a published Space, surfaced as {success:false}', async () => {
    const create = await router.handle(Channels.webhooksCreate.name, {
      name: 'News', method: 'GET', url: 'http://example.com/news', parameterized: false
    });
    const webhookId = (create as { ok: true; data: { id: string } }).data.id;

    const spaceRes = await router.handle(Channels.spacesCreate.name, {
      name: 'S', strategy: Strategy.RoundRobin, defaultModel: 'm', maxRounds: 5, allowedWebhookIds: [webhookId]
    });
    const spaceId = (spaceRes as { ok: true; data: { id: string } }).data.id;
    await router.handle(Channels.agentsCreate.name, { spaceId, name: 'A', role: 'R', systemPrompt: 'sys', position: 0 });
    await router.handle(Channels.spacesPublish.name, { id: spaceId });

    const del = await router.handle(Channels.webhooksDelete.name, { id: webhookId });
    expect(del.ok).toBe(true);
    if (del.ok) {
      const data = del.data as { success: boolean; affectedSpaces: string[] };
      expect(data.success).toBe(false);
      expect(data.affectedSpaces).toContain('S');
    }
  });

  it('webhooks:test fetches the URL and returns {ok, status, snippet}', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => 'pong' });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const res = await router.handle(Channels.webhooksTest.name, {
        name: 'Ping', method: 'GET', url: 'http://example.com/ping', parameterized: false
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        const data = res.data as { ok: boolean; status: number; snippet: string };
        expect(data.ok).toBe(true);
        expect(data.status).toBe(200);
        expect(data.snippet).toBe('pong');
      }
      expect(fetchSpy).toHaveBeenCalledWith('http://example.com/ping', expect.objectContaining({ method: 'GET' }));
    } finally {
      vi.unstubAllGlobals();
    }
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

  it('spaces:list/get annotate latestPdfPath from the most recent run, undefined when none has one', async () => {
    const createRes = await router.handle(Channels.spacesCreate.name, {
      name: 'S', strategy: Strategy.RoundRobin, defaultModel: 'm', maxRounds: 5
    });
    const spaceId = (createRes as { ok: true; data: { id: string } }).data.id;

    const getNoRuns = await router.handle(Channels.spacesGet.name, { id: spaceId });
    if (getNoRuns.ok) expect((getNoRuns.data as { latestPdfPath?: string }).latestPdfPath).toBeUndefined();

    // An older run has a PDF, but a newer run (no PDF yet) should win.
    repos.runs.create({
      id: randomUUID(), spaceId, problem: 'p1', status: RunStatus.Completed, roundsUsed: 1, startedAt: 1000, finishedAt: 1001
    });
    repos.runs.setPdfPath(repos.runs.listBySpace(spaceId)[0].id, '/reports/old.pdf');

    repos.runs.create({
      id: randomUUID(), spaceId, problem: 'p2', status: RunStatus.Completed, roundsUsed: 1, startedAt: 2000, finishedAt: 2001
    });

    const getNewerNoPdf = await router.handle(Channels.spacesGet.name, { id: spaceId });
    if (getNewerNoPdf.ok) expect((getNewerNoPdf.data as { latestPdfPath?: string }).latestPdfPath).toBeUndefined();

    repos.runs.setPdfPath(repos.runs.listBySpace(spaceId)[0].id, '/reports/new.pdf');

    const getNewerWithPdf = await router.handle(Channels.spacesGet.name, { id: spaceId });
    if (getNewerWithPdf.ok) expect((getNewerWithPdf.data as { latestPdfPath?: string }).latestPdfPath).toBe('/reports/new.pdf');

    const listRes = await router.handle(Channels.spacesList.name, {});
    if (listRes.ok) expect((listRes.data as { latestPdfPath?: string }[])[0].latestPdfPath).toBe('/reports/new.pdf');
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

  it('runs:openPdf delegates to shell and surfaces errors, for a file that actually exists', async () => {
    const okPath = join(settingsDir, 'ok.pdf');
    const errorPath = join(settingsDir, 'error.pdf');
    writeFileSync(okPath, 'fake pdf bytes');
    writeFileSync(errorPath, 'fake pdf bytes');

    const successRes = await router.handle(Channels.runsOpenPdf.name, { path: okPath });
    expect(successRes.ok).toBe(true);

    const errRes = await router.handle(Channels.runsOpenPdf.name, { path: errorPath });
    expect(errRes.ok).toBe(false);
    if (!errRes.ok) expect(errRes.error.message).toBe('failed to open');
  });

  it('runs:openPdf rejects with a clear message when the file genuinely does not exist', async () => {
    const res = await router.handle(Channels.runsOpenPdf.name, { path: join(settingsDir, 'never-written.pdf') });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/no longer exists|still generating/i);
  });

  it('runs:showInFolder delegates to shell, for a file that actually exists', async () => {
    const okPath = join(settingsDir, 'ok2.pdf');
    writeFileSync(okPath, 'fake pdf bytes');
    const res = await router.handle(Channels.runsShowInFolder.name, { path: okPath });
    expect(res.ok).toBe(true);
  });

  it('runs:showInFolder rejects with a clear message when the file genuinely does not exist', async () => {
    const res = await router.handle(Channels.runsShowInFolder.name, { path: join(settingsDir, 'never-written2.pdf') });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/no longer exists|still generating/i);
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

  it('lists presets and properly annotates existingSpaceId', async () => {
    // 1. Get initial presets
    const listRes1 = await router.handle(Channels.presetsList.name, {});
    expect(listRes1.ok).toBe(true);
    if (!listRes1.ok) throw new Error('Expected ok');
    
    const presets = listRes1.data as { id: string; existingSpaceId: string | null }[];
    expect(presets.length).toBeGreaterThan(0);
    expect(presets[0].existingSpaceId).toBeNull();
    
    // 2. Create a space from the first preset
    const presetId = presets[0].id;
    const createRes = await router.handle(Channels.spacesCreateFromPreset.name, { presetId });
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) throw new Error('Expected ok');
    
    const createdSpace = createRes.data as { id: string };
    
    // 3. List presets again and verify existingSpaceId is populated
    const listRes2 = await router.handle(Channels.presetsList.name, {});
    if (listRes2.ok) {
      const presets2 = listRes2.data as { id: string; existingSpaceId: string | null }[];
      const targetPreset = presets2.find(p => p.id === presetId);
      expect(targetPreset?.existingSpaceId).toBe(createdSpace.id);
    }
  });

  it('createFromPreset throws on unknown preset', async () => {
    const createRes = await router.handle(Channels.spacesCreateFromPreset.name, { presetId: 'does-not-exist' });
    expect(createRes.ok).toBe(false);
    if (!createRes.ok) expect(createRes.error.message).toMatch(/Unknown preset/i);
  });
});
