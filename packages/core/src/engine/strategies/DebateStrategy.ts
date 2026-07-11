import { AgentStrategy, ExecutionState } from './AgentStrategy.js';
import { buildAgentMessages, callAgent, extractFinalAnswer } from './AgentCaller.js';

const NO_OBJECTIONS = /<no_objections\s*\/>/i;

/**
 * One debate round = a concurrent propose phase followed by a concurrent
 * critique phase. Converges when no critic raises a blocking objection.
 */
export class DebateStrategy implements AgentStrategy {
  public async executeRound(state: ExecutionState): Promise<{ finalAnswer?: string }> {
    const agents = state.agents;
    if (agents.length === 0) throw new Error('No agents available for Debate');

    // Propose phase (concurrent).
    const proposals = await Promise.all(
      agents.map(async (agent) => {
        const messages = buildAgentMessages(
          agent,
          state.run.problem,
          state.messages,
          'Propose your best, concrete solution to the problem.'
        );
        const msg = await callAgent(state, agent, messages);
        return { agent, content: msg.content };
      })
    );
    for (const p of proposals) {
      state.messages.push({ role: 'assistant', content: `PROPOSAL by ${p.agent.name}: ${p.content}` });
    }

    // Critique phase (concurrent).
    const proposalDigest = proposals.map((p) => `Proposal by ${p.agent.name}:\n${p.content}`).join('\n\n');
    const critiques = await Promise.all(
      agents.map(async (agent) => {
        const messages = buildAgentMessages(
          agent,
          state.run.problem,
          state.messages,
          'Critique the proposals below. If you have NO blocking objections and consider the solution ready, ' +
            `output <no_objections/>. Otherwise list your objections.\n\n${proposalDigest}`
        );
        const msg = await callAgent(state, agent, messages);
        return { agent, content: msg.content };
      })
    );

    let objectionRaised = false;
    for (const c of critiques) {
      state.messages.push({ role: 'assistant', content: `CRITIQUE by ${c.agent.name}: ${c.content}` });
      if (!NO_OBJECTIONS.test(c.content)) objectionRaised = true;
    }

    if (!objectionRaised) {
      // Converged: prefer a proposal that already carries a tagged final answer,
      // otherwise combine the proposals as the best-effort result.
      const tagged = proposals.map((p) => extractFinalAnswer(p.content)).find((a) => a);
      const finalAnswer = tagged ?? proposals.map((p) => `${p.agent.name}: ${p.content}`).join('\n\n---\n\n');
      return { finalAnswer };
    }

    return {};
  }
}
