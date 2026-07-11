import { Agent } from '../../domain/types.js';
import { RunEventType } from '../../domain/enums.js';
import { ChatMessage } from '../../llm/index.js';
import { ExecutionState } from './AgentStrategy.js';

const COLLAB_INSTRUCTIONS =
  'You are collaborating with other agents to solve a problem. Think step by step. ' +
  'When you are confident you have the complete final solution, output it wrapped in ' +
  '<final_answer>...</final_answer> tags, with the answer as plain text/markdown ' +
  '(no JSON, no escaping needed).';

// Cap on how many times a single agent turn may loop through tool calls.
const MAX_TOOL_ITERATIONS = 5;

/**
 * Builds the message list for an agent turn: identity + role prompt +
 * collaboration + context. Identity is injected here at run time - role
 * templates are generic and contain no agent name, but agents must still
 * know who they are (the orchestrator addresses workers by name).
 */
export function buildAgentMessages(
  agent: Agent,
  problem: string,
  transcript: ChatMessage[],
  extraSystem?: string
): ChatMessage[] {
  const identity = `You are the agent named "${agent.name}".`;
  const system = [identity, agent.systemPrompt, COLLAB_INSTRUCTIONS, extraSystem].filter(Boolean).join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: problem },
    ...transcript
  ];
}

/** Extracts the tag-delimited completion signal, if present. */
export function extractFinalAnswer(content: string): string | undefined {
  const m = content.match(/<final_answer>([\s\S]*?)<\/final_answer>/i);
  return m ? m[1].trim() : undefined;
}

/**
 * Runs one agent turn to completion, including the tool-call loop:
 * LLM -> tool_calls -> callTool -> tool results -> LLM, until the model
 * stops requesting tools (or the iteration cap is hit). Emits transcript
 * events along the way and returns the final assistant message.
 */
export async function callAgent(
  state: ExecutionState,
  agent: Agent,
  messages: ChatMessage[]
): Promise<ChatMessage> {
  const model = agent.modelId || state.space.defaultModel;
  state.onEvent({ type: RunEventType.RoundStart, agentId: agent.id, payload: { model } });

  const working = [...messages];
  let iterations = 0;

  for (;;) {
    const response = await state.concurrencyLimiter.run(
      () =>
        state.lmStudioClient.chat(
          {
            model,
            messages: working,
            tools: state.tools.length > 0 ? state.tools : undefined
          },
          () => {},
          state.signal
        ),
      state.signal
    );

    const msg = response.message;
    state.onEvent({ type: RunEventType.AgentMessage, agentId: agent.id, payload: { message: msg } });
    working.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0 || iterations >= MAX_TOOL_ITERATIONS) {
      return msg;
    }

    for (const tc of msg.tool_calls) {
      state.onEvent({ type: RunEventType.ToolCall, agentId: agent.id, payload: { toolCall: tc } });

      let result: string;
      let args: Record<string, unknown> | undefined;
      try {
        args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        args = undefined;
      }

      if (args === undefined) {
        // Malformed tool-call JSON: nudge the model to retry rather than crash.
        result = 'Error: your tool call arguments were not valid JSON. Please retry with valid JSON arguments.';
      } else {
        result = await state.callTool(tc.function.name, args);
      }

      const toolMsg: ChatMessage = {
        role: 'tool',
        content: result,
        name: tc.function.name,
        tool_call_id: tc.id
      };
      working.push(toolMsg);
      state.onEvent({ type: RunEventType.ToolResult, agentId: agent.id, payload: { toolCallId: tc.id, result } });
    }

    iterations++;
  }
}
