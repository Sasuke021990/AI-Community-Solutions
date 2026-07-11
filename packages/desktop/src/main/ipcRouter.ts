import { z } from 'zod';
import { randomUUID } from 'crypto';
import { Repositories, LmStudioClient, McpClientWrapper, SpaceStatus, listRoleTemplates, renderRoleTemplate } from '@acs/core';
import { Channels, IpcResult } from '../shared/ipc.js';
import { RunManager } from './RunManager.js';
import { SettingsStore } from './SettingsStore.js';

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

    [Channels.spacesList.name]: async () => repos.spaces.list(),

    [Channels.spacesGet.name]: async (p) => {
      const { id } = Channels.spacesGet.requestSchema.parse(p);
      return repos.spaces.get(id);
    },

    [Channels.spacesCreate.name]: async (p) => {
      const input = Channels.spacesCreate.requestSchema.parse(p);
      const now = Date.now();
      const space = { id: randomUUID(), status: SpaceStatus.Draft, createdAt: now, updatedAt: now, ...input };
      repos.spaces.create(space);
      return space;
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

    [Channels.templatesRender.name]: async (p) => {
      const { templateId, agentName, spaceDescription } = Channels.templatesRender.requestSchema.parse(p);
      const template = listRoleTemplates().find((t) => t.id === templateId);
      if (!template) throw new Error(`Role template "${templateId}" not found`);
      return { content: renderRoleTemplate(template, { agentName, spaceDescription }) };
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
