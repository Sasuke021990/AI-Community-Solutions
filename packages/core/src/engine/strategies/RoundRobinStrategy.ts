import { AgentStrategy, ExecutionState } from './AgentStrategy.js';
import { buildAgentMessages, callAgent, extractFinalAnswer } from './AgentCaller.js';

/**
 * Round-robin: one executeRound is one FULL CYCLE - every agent speaks once,
 * in position order, each seeing the discussion so far. A completion signal
 * (<final_answer>) is only honored at the end of a cycle, so a strict pipeline
 * (e.g. Design Thinking's Empathize->Define->Ideate->Prototype->Test) always
 * runs all of its stages before the run can end - an early-stage agent can no
 * longer terminate the whole run by wrapping its handoff in the tag.
 *
 * Because one executeRound == one cycle, the Space's maxRounds is literally the
 * maximum number of cycles.
 */
export class RoundRobinStrategy implements AgentStrategy {
  public async executeRound(state: ExecutionState): Promise<{ finalAnswer?: string }> {
    const agents = state.agents;
    if (agents.length === 0) throw new Error('No agents available for Round Robin');

    let finalAnswer: string | undefined;

    for (const agent of agents) {
      if (state.signal?.aborted) throw new Error('Run stopped');

      const messages = buildAgentMessages(agent, state.run.problem, state.messages);
      const msg = await callAgent(state, agent, messages);

      // Record this agent's contribution in the shared transcript, attributed by name.
      state.messages.push({ role: 'assistant', content: `${agent.name}: ${msg.content}` });

      // A completion signal is remembered but not acted on until the whole
      // cycle finishes; the latest emitter in the cycle wins, so a late-stage
      // agent's conclusion supersedes an early-stage agent's premature one.
      const fa = extractFinalAnswer(msg.content);
      if (fa) finalAnswer = fa;
    }

    return finalAnswer ? { finalAnswer } : {};
  }
}
