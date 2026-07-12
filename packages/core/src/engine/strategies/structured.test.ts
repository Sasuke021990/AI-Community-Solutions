import { describe, it, expect, vi } from 'vitest';
import { LmStudioClient, ConcurrencyLimiter, ChatRequest } from '../../llm/index.js';
import { Strategy, SpaceStatus, RunStatus, RunEventType } from '../../domain/enums.js';
import { ExecutionState, EngineEvent } from './AgentStrategy.js';
import { StructuredStrategy } from './StructuredStrategy.js';
import { Phase, StructuredShape } from './StructuredTypes.js';
import { Agent } from '../../domain/types.js';

function agent(over: Partial<Agent> = {}): Agent {
  return { id: 'a', spaceId: 's', name: 'A', role: 'R', systemPrompt: 'sys', isOrchestrator: false, position: 1, ...over };
}
function makeState(over: Partial<ExecutionState> = {}): ExecutionState {
  const events: EngineEvent[] = [];
  const state: ExecutionState = {
    run: { id: 'r', spaceId: 's', problem: 'solve it', status: RunStatus.Running, roundsUsed: 0, startedAt: 0 },
    space: { id: 's', name: 'S', description: '', strategy: Strategy.Structured, defaultModel: 'm', maxRounds: 1, status: SpaceStatus.Published, createdAt: 0, updatedAt: 0 },
    agents: [], mcpClients: [], lmStudioClient: new LmStudioClient(), concurrencyLimiter: new ConcurrencyLimiter(4),
    temperature: 0.2, messages: [], tools: [], callTool: async () => '', onEvent: (e) => events.push(e), ...over
  };
  (state as unknown as { _events: EngineEvent[] })._events = events;
  return state;
}


describe('StructuredStrategy — linear', () => {
  it('runs framer -> each worker once in order -> synthesizer, and returns the synthesis as the answer', async () => {
    const blue = agent({ id: 'o', name: 'Blue', role: 'Blue Hat', isOrchestrator: true });
    const white = agent({ id: 'w1', name: 'White', role: 'White Hat', position: 1 });
    const black = agent({ id: 'w2', name: 'Black', role: 'Black Hat', position: 2 });
    const state = makeState({ agents: [blue, white, black] });

    const callOrder: string[] = [];
    vi.spyOn(state.lmStudioClient, 'chat').mockImplementation(async (req) => {
      const sys = req.messages[0].content;
      const who = sys.includes('opening this session') ? 'frame'
        : sys.includes('Every perspective has now contributed') ? 'synth'
        : sys.match(/named "(\w+)"/)?.[1] ?? '?';
      callOrder.push(who);
      if (who === 'synth') {
        return { message: { role: 'assistant', content: JSON.stringify({ content: '<final_answer>THE FINAL ANSWER</final_answer>' }) } };
      }
      return { message: { role: 'assistant', content: JSON.stringify({ content: `output from ${who}` }) } };
    });

    const shape: StructuredShape = {
      framer: blue,
      cyclePhases: [{ name: 'Discussion', kind: 'sequential', agents: [white, black], guidance: () => 'contribute' }],
      synthesizer: blue
    };
    const r = await new StructuredStrategy(shape).executeRound(state);

    expect(callOrder).toEqual(['frame', 'White', 'Black', 'synth']); // exact order, each once
    expect(r.finalAnswer).toBe('THE FINAL ANSWER');
  });

  it('with no synthesizer, uses the last phase agent output and strips a stray <final_answer> tag', async () => {
    const a1 = agent({ id: 'a1', name: 'A1', position: 1 });
    const a2 = agent({ id: 'a2', name: 'A2', position: 2 });
    const state = makeState({ agents: [a1, a2] });
    vi.spyOn(state.lmStudioClient, 'chat').mockResolvedValue({
      message: { role: 'assistant', content: JSON.stringify({ content: '<final_answer>last word</final_answer>' }) }
    });
    const shape: StructuredShape = {
      cyclePhases: [{ name: 'Pipeline', kind: 'sequential', agents: [a1, a2], guidance: () => 'go' }]
    };
    const r = await new StructuredStrategy(shape).executeRound(state);
    expect(r.finalAnswer).toBe('last word');
  });

  it('retries once on an empty response, then records (no contribution) and continues', async () => {
    const a1 = agent({ id: 'a1', name: 'A1', role: 'Solo', position: 1 });
    const state = makeState({ agents: [a1] });
    let n = 0;
    vi.spyOn(state.lmStudioClient, 'chat').mockImplementation(async () => {
      n++;
      // Return invalid JSON (or empty) the first time so it retries,
      // and invalid JSON the second time so it falls back to raw text.
      return { message: { role: 'assistant', content: '' } };
    });
    const shape: StructuredShape = {
      cyclePhases: [{ name: 'P', kind: 'sequential', agents: [a1], guidance: () => 'go' }]
    };
    const r = await new StructuredStrategy(shape).executeRound(state);
    expect(n).toBe(4); // 1 call + 1 schema retry = 2. Then Strategy empty retry does it again -> 4.
    const events = (state as unknown as { _events: EngineEvent[] })._events;
    expect(events.some((e) => e.type === RunEventType.System && String(e.payload.note).includes('no contribution'))).toBe(true);
    expect(r.halt).toBe(true); // nothing usable -> salvage
  });

  it('throws "Run stopped" when the signal aborts before a phase', async () => {
    const a1 = agent({ id: 'a1', position: 1 });
    const ac = new AbortController(); ac.abort();
    const state = makeState({ agents: [a1], signal: ac.signal });

    const shape: StructuredShape = { cyclePhases: [{ name: 'P', kind: 'sequential', agents: [a1], guidance: () => 'go' }] };
    await expect(new StructuredStrategy(shape).executeRound(state)).rejects.toThrow(/Run stopped/);
  });
});

describe('StructuredStrategy — cyclical & converging', () => {
  it('repeats the cycle group exactly `maxRounds` times (OODA)', async () => {
    const o = agent({ id: 'o', name: 'Obs', role: 'Observe', position: 1 });
    const d = agent({ id: 'd', name: 'Dec', role: 'Decide', position: 2 });
    const state = makeState({ agents: [o, d], space: { ...makeState().space, maxRounds: 3 } });
    let calls = 0;
    vi.spyOn(state.lmStudioClient, 'chat').mockImplementation(async () => {
      calls++;
      return { message: { role: 'assistant', content: JSON.stringify({ content: 'cycle output' }) } };
    });
    const shape: StructuredShape = {
      cyclePhases: [{ name: 'OODA', kind: 'sequential', agents: [o, d], guidance: () => 'go' }]
    };
    await new StructuredStrategy(shape).executeRound(state);
    expect(calls).toBe(6); // 2 agents x 3 cycles, no framer/synth
  });

  it('runs a parallel phase concurrently and stops early on convergence (Debate)', async () => {
    const a1 = agent({ id: 'a1', name: 'One', role: 'One', position: 1 });
    const a2 = agent({ id: 'a2', name: 'Two', role: 'Two', position: 2 });
    const state = makeState({ agents: [a1, a2], space: { ...makeState().space, maxRounds: 8 } });

    let round = 0;
    vi.spyOn(state.lmStudioClient, 'chat').mockImplementation(async (req: ChatRequest) => {
      const isCritique = req.messages.some((m) => typeof m.content === 'string' && m.content.includes('CRITIQUE_PHASE'));
      if (isCritique) return { message: { role: 'assistant', content: JSON.stringify({ content: '<no_objections/>' }) } }; // converge on 1st critique
      round++;
      return { message: { role: 'assistant', content: JSON.stringify({ content: 'a proposal' }) } };
    });

    const NO_OBJ = /<no_objections\s*\/>/i;
    const propose: Phase = { name: 'Propose', kind: 'parallel', agents: [a1, a2], guidance: () => 'propose' };
    const critique: Phase = {
      name: 'Critique', kind: 'parallel', agents: [a1, a2],
      guidance: () => 'CRITIQUE_PHASE: object or output <no_objections/>',
      convergenceCheck: (results) => results.every((r) => NO_OBJ.test(r.content))
    };
    const shape: StructuredShape = { cyclePhases: [propose, critique] };
    await new StructuredStrategy(shape).executeRound(state);
    expect(round).toBe(2); // exactly ONE propose round (2 agents) - converged, no 2nd cycle
  });
});
