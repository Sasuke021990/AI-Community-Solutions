import { Agent, Run, Space, RunEventType } from '../../domain/types.js';
import { McpClientWrapper } from '../../mcp/McpClient.js';
import { LmStudioClient, ConcurrencyLimiter, ChatMessage } from '../../llm/index.js';

export interface ExecutionState {
  run: Run;
  space: Space;
  agents: Agent[];
  mcpClients: McpClientWrapper[];
  lmStudioClient: LmStudioClient;
  concurrencyLimiter: ConcurrencyLimiter;
  messages: ChatMessage[];
  onEvent: (event: { type: RunEventType, payload: unknown, agentId?: string }) => void;
  signal?: AbortSignal;
}

export interface AgentStrategy {
  executeRound(state: ExecutionState): Promise<{ finalAnswer?: string }>;
}
