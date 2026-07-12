import { z } from 'zod';
import { randomUUID } from 'crypto';
import { Repositories, LmStudioClient, McpClientWrapper, Space, SpaceStatus, listRoleTemplates, listSpacePresets, SpacePreset, fetchWebhook } from '@acs/core';
import { Channels, IpcResult } from '../shared/ipc.js';
import { RunManager } from './RunManager.js';
import { SettingsStore } from './SettingsStore.js';

/**
 * hasActiveRun is deliberately NOT part of @acs/core's Space type - it's a
 * fact from joining against the runs table, not a property of a Space, so
 * it's attached only at the IPC response boundary.
 */
export type SpaceWithActivity = Space & { hasActiveRun: boolean };

export type PresetWithStatus = SpacePreset & { existingSpaceId: string | null };

export interface IpcRouterDeps {
  repos: Repositories;
  getLmStudioClient: () => LmStudioClient;
  runManager: RunManager;
  settingsStore: SettingsStore;
}

type Handler = (payload: unknown) => Promise<unknown>;

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

function fail(e: unknown): IpcResult<never> {
  if (e instanceof z.ZodError) {
    return { ok: false, error: { code: 'INVALID_PAYLOAD', message: 'Invalid request payload', details: e.issues } };
  }
  const message = e instanceof Error ? e.message : String(e);
  return { ok: false, error: { code: 'ERROR', message } };
}

export function createIpcRouter(deps: IpcRouterDeps) {
  const { repos, getLmStudioClient, runManager, settingsStore } = deps;

  const withActivity = (space: Space): SpaceWithActivity => ({
    ...space,
    hasActiveRun: repos.runs.hasActiveRun(space.id)
  });

  const handlers: Record<string, Handler> = {
    [Channels.mcpList.name]: async () => repos.mcpServers.list(),

    [Channels.mcpCreate.name]: async (p) => {
      const input = Channels.mcpCreate.requestSchema.parse(p);
      const config = { id: randomUUID(), createdAt: Date.now(), ...input };
      repos.mcpServers.create(config);
      return config;
    },

    [Channels.mcpUpdate.name]: async (p) => {
      const input = Channels.mcpUpdate.requestSchema.parse(p);
      const existing = repos.mcpServers.list().find((m) => m.id === input.id);
      if (!existing) throw new Error('MCP server not found');
      repos.mcpServers.update({ ...existing, ...input });
      return undefined;
    },

    [Channels.mcpDelete.name]: async (p) => {
      const { id } = Channels.mcpDelete.requestSchema.parse(p);
      return repos.mcpServers.delete(id);
    },

    [Channels.mcpTest.name]: async (p) => {
      const input = Channels.mcpTest.requestSchema.parse(p);
      const client = new McpClientWrapper({ id: 'test', createdAt: Date.now(), ...input });
      return client.testConnection();
    },

    [Channels.webhooksList.name]: async () => repos.webhooks.list(),

    [Channels.webhooksCreate.name]: async (p) => {
      const input = Channels.webhooksCreate.requestSchema.parse(p);
      const config = { id: randomUUID(), createdAt: Date.now(), ...input };
      repos.webhooks.create(config);
      return config;
    },

    [Channels.webhooksUpdate.name]: async (p) => {
      const input = Channels.webhooksUpdate.requestSchema.parse(p);
      const existing = repos.webhooks.list().find((w) => w.id === input.id);
      if (!existing) throw new Error('Webhook not found');
      repos.webhooks.update({ ...existing, ...input });
      return undefined;
    },

    [Channels.webhooksDelete.name]: async (p) => {
      const { id } = Channels.webhooksDelete.requestSchema.parse(p);
      return repos.webhooks.delete(id);
    },

    [Channels.webhooksTest.name]: async (p) => {
      const input = Channels.webhooksTest.requestSchema.parse(p);
      const w = { id: 'test', createdAt: Date.now(), ...input };
      const r = await fetchWebhook(w, input.parameterized ? 'test' : undefined);
      return { ok: r.ok, status: r.status, snippet: r.body.slice(0, 500) };
    },

    [Channels.spacesList.name]: async () => repos.spaces.list().map(withActivity),

    [Channels.spacesGet.name]: async (p) => {
      const { id } = Channels.spacesGet.requestSchema.parse(p);
      const space = repos.spaces.get(id);
      return space ? withActivity(space) : null;
    },

    [Channels.spacesCreate.name]: async (p) => {
      const input = Channels.spacesCreate.requestSchema.parse(p);
      const now = Date.now();
      const space = { id: randomUUID(), status: SpaceStatus.Draft, createdAt: now, updatedAt: now, ...input };
      repos.spaces.create(space);
      return withActivity(space);
    },

    [Channels.spacesUpdate.name]: async (p) => {
      const input = Channels.spacesUpdate.requestSchema.parse(p);
      const existing = repos.spaces.get(input.id);
      if (!existing) throw new Error('Space not found');
      repos.spaces.update({ ...existing, ...input, updatedAt: Date.now() });
      return undefined;
    },

    [Channels.spacesDelete.name]: async (p) => {
      const { id } = Channels.spacesDelete.requestSchema.parse(p);
      repos.spaces.delete(id);
      return undefined;
    },

    [Channels.spacesPublish.name]: async (p) => {
      const { id } = Channels.spacesPublish.requestSchema.parse(p);
      return repos.spaces.publish(id);
    },

    [Channels.spacesUnpublish.name]: async (p) => {
      const { id } = Channels.spacesUnpublish.requestSchema.parse(p);
      repos.spaces.unpublish(id);
      return undefined;
    },

    [Channels.agentsListBySpace.name]: async (p) => {
      const { spaceId } = Channels.agentsListBySpace.requestSchema.parse(p);
      return repos.agents.listBySpace(spaceId);
    },

    [Channels.agentsCreate.name]: async (p) => {
      const input = Channels.agentsCreate.requestSchema.parse(p);
      const agent = { id: randomUUID(), ...input };
      repos.agents.create(agent);
      return agent;
    },

    [Channels.agentsUpdate.name]: async (p) => {
      const input = Channels.agentsUpdate.requestSchema.parse(p);
      repos.agents.update(input);
      return undefined;
    },

    [Channels.agentsDelete.name]: async (p) => {
      const { id, spaceId } = Channels.agentsDelete.requestSchema.parse(p);
      repos.agents.delete(id, spaceId);
      return undefined;
    },

    [Channels.runsStart.name]: async (p) => {
      const { spaceId, problem } = Channels.runsStart.requestSchema.parse(p);
      return runManager.startRun(spaceId, problem);
    },

    [Channels.runsStop.name]: async (p) => {
      const { runId } = Channels.runsStop.requestSchema.parse(p);
      runManager.stopRun(runId);
      return undefined;
    },

    [Channels.runsGet.name]: async (p) => {
      const { id } = Channels.runsGet.requestSchema.parse(p);
      return repos.runs.get(id);
    },

    [Channels.runsListBySpace.name]: async (p) => {
      const { spaceId } = Channels.runsListBySpace.requestSchema.parse(p);
      return repos.runs.listBySpace(spaceId);
    },

    [Channels.runsEvents.name]: async (p) => {
      const { runId } = Channels.runsEvents.requestSchema.parse(p);
      return repos.runEvents.listByRun(runId);
    },

    [Channels.modelsList.name]: async () => ({ models: await getLmStudioClient().listModels() }),

    [Channels.settingsGet.name]: async () => settingsStore.get(),

    [Channels.settingsSet.name]: async (p) => {
      const patch = Channels.settingsSet.requestSchema.parse(p);
      return settingsStore.update(patch);
    },

    [Channels.templatesList.name]: async () => listRoleTemplates(),

    [Channels.presetsList.name]: async () => {
      const presets = listSpacePresets();
      const spaces = repos.spaces.list();
      return presets.map((p): PresetWithStatus => ({
        ...p,
        existingSpaceId: spaces.find((s) => s.presetId === p.id)?.id ?? null
      }));
    },

    [Channels.spacesCreateFromPreset.name]: async (p) => {
      const { presetId } = Channels.spacesCreateFromPreset.requestSchema.parse(p);
      const preset = listSpacePresets().find((pr) => pr.id === presetId);
      if (!preset) throw new Error(`Unknown preset "${presetId}"`);

      const now = Date.now();
      const spaceId = randomUUID();
      const space = {
        id: spaceId,
        name: preset.name,
        description: preset.description,
        strategy: preset.strategy,
        defaultModel: '',
        maxRounds: preset.maxRounds,
        status: SpaceStatus.Draft as SpaceStatus,
        presetId: preset.id,
        createdAt: now,
        updatedAt: now
      };
      const agents = preset.agents.map((a, i) => ({
        id: randomUUID(),
        spaceId,
        name: a.name,
        role: a.role,
        systemPrompt: a.systemPrompt,
        isOrchestrator: a.isOrchestrator,
        position: i
      }));

      const created = repos.spaces.createFromPreset(space, agents);
      return withActivity(created);
    }
  };

  return {
    async handle(channel: string, payload: unknown): Promise<IpcResult<unknown>> {
      const handler = handlers[channel];
      if (!handler) return fail(new Error(`Unknown channel: ${channel}`));
      try {
        return ok(await handler(payload));
      } catch (e) {
        return fail(e);
      }
    }
  };
}
