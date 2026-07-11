import { AgentStrategy, ExecutionState } from './AgentStrategy.js';
import { buildAgentMessages, callAgent, extractFinalAnswer } from './AgentCaller.js';

export class RoundRobinStrategy implements AgentStrategy {
  private currentIndex = 0;

  public async executeRound(state: ExecutionState): Promise<{ finalAnswer?: string }> {
    const agents = state.agents;
    if (agents.length === 0) throw new Error('No agents available for Round Robin');

    const agent = agents[this.currentIndex % agents.length];
    this.currentIndex++;

    const messages = buildAgentMessages(agent, state.run.problem, state.messages);
    const msg = await callAgent(state, agent, messages);

    // Record this agent's contribution in the shared transcript, attributed by name.
    state.messages.push({ role: 'assistant', content: `${agent.name}: ${msg.content}` });

    const finalAnswer = extractFinalAnswer(msg.content);
    return finalAnswer ? { finalAnswer } : {};
  }
}
