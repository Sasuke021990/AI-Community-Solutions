import { Agent } from '../../domain/types.js';

/** Context passed to a phase's per-turn guidance builder. */
export interface PhaseContext {
  phaseName: string;
  cycle: number;
  totalCycles: number;
}

/** One unit of a structured run: one or more agents run together (parallel) or in order (sequential). */
export interface Phase {
  name: string;
  agents: Agent[];
  kind: 'sequential' | 'parallel';
  /** The extraSystem guidance each agent in this phase receives. */
  guidance: (ctx: PhaseContext) => string;
  /** If provided and returns true after the phase runs, the cycle loop stops early (Debate). */
  convergenceCheck?: (results: { agent: Agent; content: string }[]) => boolean;
}

/**
 * The fully code-decided shape of a structured run. No LLM ever chooses who runs.
 * - framer/synthesizer: the optional isOrchestrator agent (often the same agent for both).
 * - cyclePhases: the phase(s) that repeat up to `cycles` times.
 */
export interface StructuredShape {
  framer?: Agent;
  cyclePhases: Phase[];
  synthesizer?: Agent;
}
