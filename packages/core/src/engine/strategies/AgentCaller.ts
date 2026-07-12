import { Agent } from '../../domain/types.js';
import { RunEventType } from '../../domain/enums.js';
import { ChatMessage } from '../../llm/index.js';
import { ExecutionState } from './AgentStrategy.js';

const COLLAB_INSTRUCTIONS =
  'You are collaborating with other agents to solve a problem. Think step by step. ' +
  'If your role is one stage of a larger process, do your part thoroughly and hand off ' +
  'to the next agent - do NOT declare a final answer for the whole problem. ' +
  'Only when the ENTIRE problem is fully solved and no further work from other agents is ' +
  'needed, output the complete solution wrapped in <final_answer>...</final_answer> tags, ' +
  'as plain text/markdown (no JSON, no escaping needed). Do not wrap a partial contribution ' +
  'or a handoff to another agent in those tags.';

// Cap on how many times a single agent turn may loop through tool calls.
const MAX_TOOL_ITERATIONS = 5;
const FREQUENCY_PENALTY = 0.3;

export const TURN_OUTPUT_SCHEMA = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'agent_turn',
    schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Your full contribution for this turn.' },
        keyPoints: { type: 'array', items: { type: 'string' }, description: 'Optional: 1-5 short highlights of this contribution.' }
      },
      required: ['content']
    },
    strict: true
  }
};

export interface ParsedTurn { content: string; keyPoints?: string[] }

export function parseTurnOutput(raw: string): ParsedTurn | undefined {
  try {
    const obj = JSON.parse(raw);
    if (typeof obj?.content !== 'string' || !obj.content.trim()) return undefined;
    const keyPoints = Array.isArray(obj.keyPoints) ? obj.keyPoints.filter((k: unknown) => typeof k === 'string') : undefined;
    return { content: obj.content, keyPoints: keyPoints?.length ? keyPoints : undefined };
  } catch {
    return undefined;
  }
}

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
  messages: ChatMessage[],
  roundStartMeta?: Record<string, unknown>
): Promise<ChatMessage> {
  const model = agent.modelId || state.space.defaultModel;
  state.onEvent({ type: RunEventType.RoundStart, agentId: agent.id, payload: { model, ...roundStartMeta } });

  const working = [...messages];
  let iterations = 0;

  for (;;) {
    const response = await state.concurrencyLimiter.run(
      () =>
        state.lmStudioClient.chat(
          {
            model,
            messages: working,
            tools: state.tools.length > 0 ? state.tools : undefined,
            temperature: state.temperature,
            frequency_penalty: FREQUENCY_PENALTY,
            response_format: TURN_OUTPUT_SCHEMA
          },
          (token) => state.onToken?.(agent.id, token),
          state.signal
        ),
      state.signal
    );

    const msg = response.message;

    if (!msg.tool_calls || msg.tool_calls.length === 0 || iterations >= MAX_TOOL_ITERATIONS) {
      let parsed = parseTurnOutput(msg.content);
      if (!parsed) {
        // The first response is already a real, usable answer - it just
        // didn't parse as the requested schema. A retry is a bonus
        // reliability improvement, not something that should be able to
        // discard a working response: if the retry call itself throws
        // (network error, timeout, abort), fall back to msg.content
        // rather than losing this turn's content entirely.
        try {
          const retryMsgs = [...working, msg, {
            role: 'user' as const,
            content: 'Your response was not valid JSON matching the required schema {"content": string, "keyPoints"?: string[]}. Reply again in that exact JSON shape.'
          }];
          const retryResp = await state.concurrencyLimiter.run(
            () => state.lmStudioClient.chat(
              { model, messages: retryMsgs, temperature: state.temperature, frequency_penalty: FREQUENCY_PENALTY, response_format: TURN_OUTPUT_SCHEMA },
              () => {}, state.signal
            ), state.signal
          );
          parsed = parseTurnOutput(retryResp.message.content);
          if (!parsed) parsed = { content: (retryResp.message.content || msg.content).trim() };
        } catch {
          parsed = { content: msg.content.trim() };
        }
      }

      const finalMsg: ChatMessage = { ...msg, content: parsed.content };
      state.onEvent({
        type: RunEventType.AgentMessage,
        agentId: agent.id,
        payload: { message: finalMsg, keyPoints: parsed.keyPoints }
      });
      working.push(finalMsg);
      return finalMsg;
    }

    state.onEvent({ type: RunEventType.AgentMessage, agentId: agent.id, payload: { message: msg } });
    working.push(msg);

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
