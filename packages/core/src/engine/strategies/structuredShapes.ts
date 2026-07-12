import { Agent, Space } from '../../domain/types.js';
import { Phase, StructuredShape } from './StructuredTypes.js';

const NO_OBJECTIONS = /<no_objections\s*\/>/i;

const byPosition = (agents: Agent[]) => [...agents].sort((a, b) => a.position - b.position);
const workersOf = (agents: Agent[]) => byPosition(agents.filter((a) => !a.isOrchestrator));
const framerOf = (agents: Agent[]) => agents.find((a) => a.isOrchestrator);

/** Six Hats / TRIZ / Means-End / custom-with-framer: framer + one sequential worker phase + synth. */
function linearWithFramer(agents: Agent[]): StructuredShape {
  const framer = framerOf(agents);
  return {
    framer,
    synthesizer: framer,
    cyclePhases: [{
      name: 'Discussion', kind: 'sequential', agents: workersOf(agents),
      guidance: (c) => `You are contributing in turn (${c.phaseName}). Speak strictly from your own role's ` +
        `perspective, building on the discussion so far. Do not coordinate others or declare a final answer.`
    }]
  };
}

/** Design Thinking / Core Framework / plain pipeline: no framer, one sequential phase, last output = answer. */
function linearNoFramer(agents: Agent[]): StructuredShape {
  return {
    cyclePhases: [{
      name: 'Pipeline', kind: 'sequential', agents: workersOf(agents),
      guidance: () => `Perform your stage of this process thoroughly, building on the previous stages above.`
    }]
  };
}

/** OODA: no framer, the whole ordered group repeats `maxRounds` cycles. */
function oodaShape(agents: Agent[]): StructuredShape {
  return {
    cyclePhases: [{
      name: 'OODA cycle', kind: 'sequential', agents: workersOf(agents),
      guidance: (c) => `Cycle ${c.cycle} of ${c.totalCycles}. Perform your stage using everything learned in ` +
        `previous cycles. On the final cycle, drive toward a concrete decision/action.`
    }]
  };
}

/** Debate: propose (parallel) then critique (parallel, converge on unanimous <no_objections/>). */
function debateShape(agents: Agent[]): StructuredShape {
  const all = byPosition(agents.filter((a) => !a.isOrchestrator));
  const propose: Phase = {
    name: 'Propose', kind: 'parallel', agents: all,
    guidance: () => 'Propose your best, concrete solution to the problem.'
  };
  const critique: Phase = {
    name: 'Critique', kind: 'parallel', agents: all,
    guidance: () => 'Critique the proposals above. If you have NO blocking objections, output <no_objections/>. ' +
      'Otherwise list your objections.',
    convergenceCheck: (results) => results.every((r) => NO_OBJECTIONS.test(r.content))
  };
  return { cyclePhases: [propose, critique] };
}

const PRESET_SHAPES: Record<string, (agents: Agent[]) => StructuredShape> = {
  'six-thinking-hats': linearWithFramer,
  'triz': linearWithFramer,
  'means-end-analysis': linearWithFramer,
  'design-thinking': linearNoFramer,
  'the-core-framework': linearNoFramer,
  'ooda-loop': oodaShape,
  'alternative-approaches': debateShape
};

/**
 * Derive the code-decided shape. Presets use their known methodology mapping;
 * a custom structured Space (no presetId) is always a simple linear pipeline,
 * with a framer/synthesizer only if it has an isOrchestrator agent.
 */
export function deriveStructuredShape(space: Space, agents: Agent[]): StructuredShape {
  const fn = space.presetId ? PRESET_SHAPES[space.presetId] : undefined;
  if (fn) return fn(agents);
  return framerOf(agents) ? linearWithFramer(agents) : linearNoFramer(agents);
}
