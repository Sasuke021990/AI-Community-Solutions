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
  /** The run being executed. */
  run: Run;
  /** The space this run belongs to. */
  space: Space;
  /** The temperature for the run, mapped from Space or default. */
  temperature: number;
  /** All agents in this space. */
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
  executeRound(state: ExecutionState): Promise<{ finalAnswer?: string; halt?: boolean }>;
}
