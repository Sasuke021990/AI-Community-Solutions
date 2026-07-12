import { Agent, Run, Space } from '../../domain/types.js';
import { RunEventType } from '../../domain/enums.js';
import { McpClientWrapper } from '../../mcp/McpClient.js';
import { LmStudioClient, ConcurrencyLimiter, ChatMessage } from '../../llm/index.js';

export interface OpenAiTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

export interface EngineEvent {
  type: RunEventType;
  payload: Record<string, unknown>;
  agentId?: string;
}

export interface ExecutionState {
  run: Run;
  space: Space;
  agents: Agent[];
  mcpClients: McpClientWrapper[];
  lmStudioClient: LmStudioClient;
  concurrencyLimiter: ConcurrencyLimiter;
  messages: ChatMessage[];
  /** OpenAI-format tool schemas offered to every agent (namespaced). */
  tools: OpenAiTool[];
  /** Resolves a namespaced tool call; never throws (returns an error string). */
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  onEvent: (event: EngineEvent) => void;
  /** Optional: called per token delta from a streaming LLM response. Never persisted. */
  onToken?: (agentId: string, token: string) => void;
  signal?: AbortSignal;
}

export interface AgentStrategy {
  executeRound(state: ExecutionState): Promise<{ finalAnswer?: string }>;
}
