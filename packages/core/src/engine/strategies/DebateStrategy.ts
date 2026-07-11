import { AgentStrategy, ExecutionState } from './AgentStrategy.js';
import { RunEventType } from '../../domain/enums.js';
import { ChatMessage } from '../../llm/index.js';

export class DebateStrategy implements AgentStrategy {
  private currentIndex = 0;

  public async executeRound(state: ExecutionState): Promise<{ finalAnswer?: string }> {
    const agents = state.agents;
    if (agents.length === 0) throw new Error('No agents available for Debate');

    // Simple alternation for debate
    const agent = agents[this.currentIndex % agents.length];
    this.currentIndex++;

    const messages: ChatMessage[] = [
      { role: 'system', content: agent.systemPrompt },
      { role: 'user', content: state.run.problem },
      ...state.messages
    ];

    state.onEvent({ type: RunEventType.RoundStart, payload: { agentId: agent.id, model: agent.modelId || state.space.defaultModel } });

    const response = await state.concurrencyLimiter.run(async () => {
      return state.lmStudioClient.chat({
        model: agent.modelId || state.space.defaultModel,
        messages
      }, () => {}, state.signal);
    }, state.signal);

    const msg = response.message;
    state.onEvent({ type: RunEventType.AgentMessage, agentId: agent.id, payload: { message: msg } });
    state.messages.push(msg);

    const finalAnswerMatch = msg.content.match(/<final_answer>([\s\S]*?)<\/final_answer>/);
    if (finalAnswerMatch) {
      return { finalAnswer: finalAnswerMatch[1].trim() };
    }

    return {};
  }
}
