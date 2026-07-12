import { Agent } from '../../domain/types.js';
import { RunEventType } from '../../domain/enums.js';
import { AgentStrategy, ExecutionState } from './AgentStrategy.js';
import { buildAgentMessages, callAgent, extractFinalAnswer } from './AgentCaller.js';
import { PhaseContext, StructuredShape } from './StructuredTypes.js';

const FRAMER_GUIDANCE =
  'You are opening this session. State the focus and what a sufficient answer looks like. ' +
  'Do NOT answer the problem yourself and do NOT address the other agents — each will contribute ' +
  'automatically, in turn, after you.';

const SYNTH_GUIDANCE =
  'Every perspective has now contributed above. Write the final answer to the problem, ' +
  'synthesizing the discussion. Your ENTIRE response is the final answer — no preamble, no tags.';

/** Final answer = the model's text, unwrapped from a <final_answer> tag if it happened to add one. */
function asFinalAnswer(content: string): string {
  return (extractFinalAnswer(content) ?? content).trim();
}

export class StructuredStrategy implements AgentStrategy {
  constructor(private shape: StructuredShape) {}

  public async executeRound(state: ExecutionState): Promise<{ finalAnswer?: string; halt?: boolean }> {
    const totalCycles = Math.max(1, state.space.maxRounds);
    const { framer, cyclePhases, synthesizer } = this.shape;

    if (state.signal?.aborted) throw new Error('Run stopped');

    // Optional framing turn (cycle 0 = "not part of the repeating body").
    if (framer) {
      await this.runOne(state, framer, () => FRAMER_GUIDANCE, { phase: 'Framing', cycle: 0, totalCycles });
    }

    let lastContent: string | undefined;
    cycleLoop: for (let cycle = 1; cycle <= totalCycles; cycle++) {
      for (const phase of cyclePhases) {
        if (state.signal?.aborted) throw new Error('Run stopped');
        const meta = { phase: phase.name, cycle, totalCycles };

        let results: { agent: Agent; content: string }[];
        if (phase.kind === 'parallel') {
          results = await Promise.all(
            phase.agents.map((a) => this.runOne(state, a, phase.guidance, meta))
          );
        } else {
          results = [];
          for (const a of phase.agents) {
            results.push(await this.runOne(state, a, phase.guidance, meta));
          }
        }
        if (results.length) lastContent = results[results.length - 1].content;
        if (phase.convergenceCheck?.(results)) break cycleLoop; // Debate: stop once critics agree
      }
    }

    // Synthesis (or, with no synthesizer, the last phase's last agent's output).
    let answer: string;
    if (synthesizer) {
      const msg = await this.runOne(state, synthesizer, () => SYNTH_GUIDANCE, {
        phase: 'Synthesis', cycle: totalCycles, totalCycles
      });
      answer = asFinalAnswer(msg.content);
    } else {
      answer = lastContent ? asFinalAnswer(lastContent) : '';
    }

    if (answer === '(no contribution)') answer = '';
    if (answer) return { finalAnswer: answer };
    state.onEvent({
      type: RunEventType.System,
      payload: { note: 'Structured run produced no answer; synthesizing a best-effort answer.' }
    });
    return { halt: true }; // RunOrchestrator.synthesize() salvages
  }

  /** Runs one agent turn with empty-response retry, appends to the transcript, returns its content. */
  private async runOne(
    state: ExecutionState,
    agent: Agent,
    guidance: (ctx: PhaseContext) => string,
    meta: { phase: string; cycle: number; totalCycles: number }
  ): Promise<{ agent: Agent; content: string }> {
    const ctx: PhaseContext = { phaseName: meta.phase, cycle: meta.cycle, totalCycles: meta.totalCycles };
    const g = guidance(ctx);

    let msg = await callAgent(state, agent, buildAgentMessages(agent, state.run.problem, state.messages, g), meta);
    if (!msg.content.trim()) {
      // One corrective retry - a single empty response shouldn't sink a whole pipeline.
      const retry = g + '\n\nYou returned an empty response. Provide your contribution now.';
      msg = await callAgent(state, agent, buildAgentMessages(agent, state.run.problem, state.messages, retry), meta);
    }

    const content = msg.content.trim() || '(no contribution)';
    if (content === '(no contribution)') {
      state.onEvent({ type: RunEventType.System, payload: { note: `${agent.role} returned no contribution.` } });
    }
    // Attributed by role, matching the other strategies' transcript convention.
    state.messages.push({ role: 'assistant', content: `${agent.role}: ${content}` });
    return { agent, content };
  }
}
