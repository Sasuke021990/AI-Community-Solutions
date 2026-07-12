import { Strategy, SpaceStatus, RunStatus, RunEventType } from './enums.js';

export interface McpServerConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled: boolean;
  createdAt: number;
}

export interface WebhookConfig {
  id: string;
  name: string;
  description: string;
  method: 'GET' | 'POST';
  url: string;
  parameterized: boolean;
  headers?: Record<string, string>;
  enabled: boolean;
  createdAt: number;
}

export interface Space {
  id: string;
  name: string;
  description: string;
  strategy: Strategy;
  defaultModel: string;
  maxRounds: number;
  status: SpaceStatus;
  presetId?: string | null;
  createdAt: number;
  updatedAt: number;
  agents?: Agent[];
  allowedMcpServerIds?: string[];
  allowedWebhookIds?: string[];
}

export interface Agent {
  id: string;
  spaceId: string;
  name: string;
  role: string;
  systemPrompt: string;
  modelId?: string | null;
  isOrchestrator: boolean;
  position: number;
}

export interface Run {
  id: string;
  spaceId: string;
  problem: string;
  status: RunStatus;
  roundsUsed: number;
  finalAnswer?: string;
  pdfPath?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface RunEvent {
  id: string;
  runId: string;
  seq: number;
  type: RunEventType;
  agentId?: string;
  payload: Record<string, unknown>;
  at: number;
}
