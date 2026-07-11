import { Agent, Run, Space } from '../../domain/types.js';
import { RunEventType } from '../../domain/enums.js';
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
  onEvent: (event: { type: RunEventType, payload: Record<string, unknown>, agentId?: string }) => void;
  signal?: AbortSignal;
}

export interface AgentStrategy {
  executeRound(state: ExecutionState): Promise<{ finalAnswer?: string }>;
}
