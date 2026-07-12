import { contextBridge, ipcRenderer } from 'electron';
import { Channels, RUN_EVENT_PUSH_CHANNEL, RUN_STATUS_PUSH_CHANNEL, IpcResult } from '../shared/ipc.js';
import type {
  McpServerConfig,
  Space,
  Agent,
  Run,
  RunEvent,
  PersistedRunEvent,
  RoleTemplate,
  WebhookConfig
} from '@acs/core';
import type { Settings, SettingsPatch } from '../main/SettingsStore.js';
import type { SpaceWithActivity, PresetWithStatus } from '../main/ipcRouter.js';

export type { SpaceWithActivity, PresetWithStatus } from '../main/ipcRouter.js';

function invoke<T>(channelName: string, payload: unknown = {}): Promise<IpcResult<T>> {
  return ipcRenderer.invoke(channelName, payload);
}

function subscribe<T>(pushChannel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T) => cb(payload);
  ipcRenderer.on(pushChannel, listener);
  return () => {
    ipcRenderer.removeListener(pushChannel, listener);
  };
}

export interface McpServerInput {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled?: boolean;
}

export interface WebhookInput {
  name: string;
  description?: string;
  method: 'GET' | 'POST';
  url: string;
  parameterized?: boolean;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface WebhookTestResult {
  ok: boolean;
  status?: number;
  snippet: string;
}

export interface SpaceInput {
  name: string;
  description?: string;
  strategy: Space['strategy'];
  defaultModel: string;
  maxRounds: number;
  allowedMcpServerIds?: string[];
  allowedWebhookIds?: string[];
}

export interface AgentInput {
  spaceId: string;
  name: string;
  role: string;
  systemPrompt: string;
  modelId?: string;
  isOrchestrator?: boolean;
  position: number;
}

export interface TestConnectionResult {
  ok: boolean;
  tools?: string[];
  error?: string;
}

export interface DeleteMcpResult {
  success: boolean;
  affectedSpaces: string[];
}

export interface PublishResult {
  success: boolean;
  issues: { field?: string; message: string }[];
}

const api = {
  mcp: {
    list: () => invoke<McpServerConfig[]>(Channels.mcpList.name),
    create: (input: McpServerInput) => invoke<McpServerConfig>(Channels.mcpCreate.name, input),
    update: (input: McpServerInput & { id: string }) => invoke<void>(Channels.mcpUpdate.name, input),
    delete: (id: string) => invoke<DeleteMcpResult>(Channels.mcpDelete.name, { id }),
    test: (input: McpServerInput) => invoke<TestConnectionResult>(Channels.mcpTest.name, input)
  },
  webhooks: {
    list: () => invoke<WebhookConfig[]>(Channels.webhooksList.name),
    create: (input: WebhookInput) => invoke<WebhookConfig>(Channels.webhooksCreate.name, input),
    update: (input: WebhookInput & { id: string }) => invoke<void>(Channels.webhooksUpdate.name, input),
    delete: (id: string) => invoke<DeleteMcpResult>(Channels.webhooksDelete.name, { id }),
    test: (input: WebhookInput) => invoke<WebhookTestResult>(Channels.webhooksTest.name, input)
  },
  spaces: {
    list: () => invoke<SpaceWithActivity[]>(Channels.spacesList.name),
    get: (id: string) => invoke<SpaceWithActivity | null>(Channels.spacesGet.name, { id }),
    create: (input: SpaceInput) => invoke<SpaceWithActivity>(Channels.spacesCreate.name, input),
    update: (input: SpaceInput & { id: string }) => invoke<void>(Channels.spacesUpdate.name, input),
    delete: (id: string) => invoke<void>(Channels.spacesDelete.name, { id }),
    publish: (id: string) => invoke<PublishResult>(Channels.spacesPublish.name, { id }),
    unpublish: (id: string) => invoke<void>(Channels.spacesUnpublish.name, { id })
  },
  agents: {
    listBySpace: (spaceId: string) => invoke<Agent[]>(Channels.agentsListBySpace.name, { spaceId }),
    create: (input: AgentInput) => invoke<Agent>(Channels.agentsCreate.name, input),
    update: (input: AgentInput & { id: string }) => invoke<void>(Channels.agentsUpdate.name, input),
    delete: (id: string, spaceId: string) => invoke<void>(Channels.agentsDelete.name, { id, spaceId })
  },
  runs: {
    start: (spaceId: string, problem: string) => invoke<{ runId: string }>(Channels.runsStart.name, { spaceId, problem }),
    stop: (runId: string) => invoke<void>(Channels.runsStop.name, { runId }),
    get: (id: string) => invoke<Run | null>(Channels.runsGet.name, { id }),
    listBySpace: (spaceId: string) => invoke<Run[]>(Channels.runsListBySpace.name, { spaceId }),
    events: (runId: string) => invoke<RunEvent[]>(Channels.runsEvents.name, { runId }),
    onEvent: (cb: (e: PersistedRunEvent) => void) => subscribe<PersistedRunEvent>(RUN_EVENT_PUSH_CHANNEL, cb),
    onStatus: (cb: (run: Run) => void) => subscribe<Run>(RUN_STATUS_PUSH_CHANNEL, cb)
  },
  models: {
    list: () => invoke<{ models: string[] }>(Channels.modelsList.name)
  },
  settings: {
    get: () => invoke<Settings>(Channels.settingsGet.name),
    set: (patch: SettingsPatch) => invoke<Settings>(Channels.settingsSet.name, patch)
  },
  presets: {
    list: () => invoke<PresetWithStatus[]>(Channels.presetsList.name),
    createFromPreset: (presetId: string) => invoke<SpaceWithActivity>(Channels.spacesCreateFromPreset.name, { presetId })
  },
  templates: {
    list: () => invoke<RoleTemplate[]>(Channels.templatesList.name)
  }
};

export type AcsApi = typeof api;

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('acs', api);
  } catch (error) {
    console.error(error);
  }
} else {
  // Non-isolated fallback; Window.acs is declared globally in renderer/src/global.d.ts.
  window.acs = api;
}
