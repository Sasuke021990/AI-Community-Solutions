import { AgentStrategy, ExecutionState } from './AgentStrategy.js';
import { RunEventType } from '../../domain/enums.js';
import { ChatMessage } from '../../llm/index.js';

export class OrchestratorStrategy implements AgentStrategy {
  public async executeRound(state: ExecutionState): Promise<{ finalAnswer?: string }> {
    const orchestrator = state.agents.find(a => a.isOrchestrator);
    if (!orchestrator) throw new Error('Orchestrator not found');

    // Build context
    const messages: ChatMessage[] = [
      { role: 'system', content: orchestrator.systemPrompt },
      { role: 'user', content: state.run.problem },
      ...state.messages
    ];

    // Collect tools
    const tools: unknown[] = [];
    for (const mcp of state.mcpClients) {
      const mcpTools = await mcp.listTools();
      for (const t of mcpTools.tools) {
        tools.push({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema
          }
        });
      }
    }

    state.onEvent({ type: RunEventType.RoundStart, payload: { agentId: orchestrator.id, model: orchestrator.modelId || state.space.defaultModel } });

    const response = await state.concurrencyLimiter.run(async () => {
      return state.lmStudioClient.chat({
        model: orchestrator.modelId || state.space.defaultModel,
        messages,
        tools: tools.length > 0 ? tools : undefined
      }, () => {
        // Stream token (could emit via event if desired)
      }, state.signal);
    }, state.signal);

    const msg = response.message;
    state.onEvent({ type: RunEventType.AgentMessage, agentId: orchestrator.id, payload: { message: msg } });
    state.messages.push(msg);

    const finalAnswerMatch = msg.content.match(/<final_answer>([\s\S]*?)<\/final_answer>/);
    if (finalAnswerMatch) {
      return { finalAnswer: finalAnswerMatch[1].trim() };
    }

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        state.onEvent({ type: RunEventType.ToolCall, agentId: orchestrator.id, payload: { toolCall: tc } });
        let resultStr = '';
        try {
          const args = JSON.parse(tc.function.arguments);
          let handled = false;
          for (const mcp of state.mcpClients) {
            const mcpTools = await mcp.listTools();
            if (mcpTools.tools.some(t => t.name === tc.function.name)) {
              const res = await mcp.callTool(tc.function.name, args);
              resultStr = res.content.map(c => c.type === 'text' ? c.text : '').join('\n');
              handled = true;
              break;
            }
          }
          if (!handled) resultStr = `Tool ${tc.function.name} not found`;
        } catch (e: unknown) {
          if (e instanceof Error) {
            resultStr = `Error calling tool: ${e.message}`;
          }
        }

        const toolMsg: ChatMessage = { role: 'tool', content: resultStr, name: tc.function.name, tool_call_id: tc.id };
        state.messages.push(toolMsg);
        state.onEvent({ type: RunEventType.ToolResult, agentId: orchestrator.id, payload: { result: resultStr, toolCallId: tc.id } });
      }
    }

    return {};
  }
}
