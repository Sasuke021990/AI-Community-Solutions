import { describe, it, expect, vi } from 'vitest';
import { LmStudioClient, ConcurrencyLimiter, ChatMessage, ChatRequest } from '../../llm/index.js';
import { Strategy, SpaceStatus, RunStatus, RunEventType } from '../../domain/enums.js';
import { ExecutionState, EngineEvent } from './AgentStrategy.js';
import { callAgent, buildAgentMessages } from './AgentCaller.js';
import { RoundRobinStrategy } from './RoundRobinStrategy.js';
import { OrchestratorStrategy, parseTaskAssignments } from './OrchestratorStrategy.js';
import { DebateStrategy } from './DebateStrategy.js';
import { Agent } from '../../domain/types.js';

function agent(over: Partial<Agent> = {}): Agent {
  return { id: 'a', spaceId: 's', name: 'A', role: 'R', systemPrompt: 'sys', isOrchestrator: false, position: 1, ...over };
}

function makeState(over: Partial<ExecutionState> = {}): ExecutionState {
  const events: EngineEvent[] = [];
  const state: ExecutionState = {
    run: { id: 'r', spaceId: 's', problem: 'solve it', status: RunStatus.Running, roundsUsed: 0, startedAt: 0 },
    space: { id: 's', name: 'S', description: '', strategy: Strategy.RoundRobin, defaultModel: 'm', maxRounds: 5, status: SpaceStatus.Published, createdAt: 0, updatedAt: 0 },
    agents: [],
    mcpClients: [],
    lmStudioClient: new LmStudioClient(),
    concurrencyLimiter: new ConcurrencyLimiter(4),
    messages: [],
    tools: [],
    callTool: async () => '',
    onEvent: (e) => events.push(e),
    ...over
  };
  (state as unknown as { _events: EngineEvent[] })._events = events;
  return state;
}

describe('buildAgentMessages identity injection', () => {
  it('injects the agent name at run time even though the stored prompt is generic', () => {
    const a = agent({ name: 'Black Hat Bob', systemPrompt: 'You are a risk assessor. Find failure modes.' });
    const messages = buildAgentMessages(a, 'should we ship?', []);
    const system = messages[0].content;
    expect(messages[0].role).toBe('system');
    expect(system).toContain('You are the agent named "Black Hat Bob".');
    expect(system).toContain('You are a risk assessor.');
    // Identity comes first, before the role prompt.
    expect(system.indexOf('Black Hat Bob')).toBeLessThan(system.indexOf('risk assessor'));
  });
});

describe('AgentCaller tool loop', () => {
  it('runs a tool call, feeds the result back, and returns the final message', async () => {
    const state = makeState({
      tools: [{ type: 'function', function: { name: 'srv__lookup' } }],
      callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
        expect(name).toBe('srv__lookup');
        expect(args).toEqual({ q: 'cats' });
        return 'RESULT=7';
      })
    });

    let call = 0;
    vi.spyOn(state.lmStudioClient, 'chat').mockImplementation(async (req: ChatRequest) => {
      call++;
      if (call === 1) {
        return {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 't1', type: 'function', function: { name: 'srv__lookup', arguments: '{"q":"cats"}' } }]
          }
        };
      }
      // second call must have seen the tool result
      const toolMsg = req.messages.find((m: ChatMessage) => m.role === 'tool');
      expect(toolMsg?.content).toBe('RESULT=7');
      return { message: { role: 'assistant', content: 'the answer is 7' } };
    });

    const a = agent();
    const msg = await callAgent(state, a, buildAgentMessages(a, state.run.problem, []));
    expect(msg.content).toBe('the answer is 7');
    expect(state.callTool).toHaveBeenCalledTimes(1);
  });

  it('nudges (does not call the tool) on malformed tool-call JSON', async () => {
    const callTool = vi.fn(async () => 'should not run');
    const state = makeState({ tools: [{ type: 'function', function: { name: 'srv__lookup' } }], callTool });

    let call = 0;
    vi.spyOn(state.lmStudioClient, 'chat').mockImplementation(async (req: ChatRequest) => {
      call++;
      if (call === 1) {
        return {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 't1', type: 'function', function: { name: 'srv__lookup', arguments: '{not valid json' } }]
          }
        };
      }
      const toolMsg = req.messages.find((m: ChatMessage) => m.role === 'tool');
      expect(toolMsg?.content).toMatch(/not valid JSON/i);
      return { message: { role: 'assistant', content: 'recovered' } };
    });

    const a = agent();
    const msg = await callAgent(state, a, buildAgentMessages(a, state.run.problem, []));
    expect(msg.content).toBe('recovered');
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe('parseTaskAssignments', () => {
  it('extracts agent name + task from task tags with double quotes', () => {
    const out = parseTaskAssignments(
      'plan: <task agent="Researcher">find sources</task> and <task agent="Writer">draft it</task>'
    );
    expect(out).toEqual([
      { agentName: 'Researcher', task: 'find sources' },
      { agentName: 'Writer', task: 'draft it' }
    ]);
  });

  it('tolerates single quotes and whitespace around the equals sign', () => {
    const out = parseTaskAssignments(
      `plan: <task agent = 'Researcher'>find sources</task> and <task agent= 'Writer' >draft it</task>`
    );
    expect(out).toEqual([
      { agentName: 'Researcher', task: 'find sources' },
      { agentName: 'Writer', task: 'draft it' }
    ]);
  });
});

describe('OrchestratorStrategy', () => {
  it('dispatches assigned subtasks to workers, then completes on final_answer', async () => {
    const orchestrator = agent({ id: 'o', name: 'Boss', isOrchestrator: true });
    const researcher = agent({ id: 'w1', name: 'Researcher' });
    const writer = agent({ id: 'w2', name: 'Writer' });
    const state = makeState({ agents: [orchestrator, researcher, writer] });

    const seen: string[] = [];
    vi.spyOn(state.lmStudioClient, 'chat').mockImplementation(async (req: ChatRequest) => {
      const sys = req.messages[0].content;
      if (sys.includes('orchestrator')) {
        // First orchestrator turn delegates; the transcript grows so the
        // second turn (after worker results) declares the final answer.
        const hasWorkerResults = state.messages.some((m) => m.content.startsWith('WORKER '));
        if (!hasWorkerResults) {
          return { message: { role: 'assistant', content: '<task agent="Researcher">dig</task><task agent="Writer">write</task>' } };
        }
        return { message: { role: 'assistant', content: '<final_answer>done</final_answer>' } };
      }
      seen.push(sys.includes('Researcher') || sys.includes('dig') ? 'researcher' : 'writer');
      return { message: { role: 'assistant', content: 'worker output' } };
    });

    const strat = new OrchestratorStrategy();
    const r1 = await strat.executeRound(state);
    expect(r1.finalAnswer).toBeUndefined();
    // both workers were dispatched
    expect(state.messages.filter((m) => m.content.startsWith('WORKER ')).length).toBe(2);

    const r2 = await strat.executeRound(state);
    expect(r2.finalAnswer).toBe('done');
  });

  it('no-progress guard: nudges on first offense, halts on second', async () => {
    const orchestrator = agent({ id: 'o', name: 'Boss', isOrchestrator: true });
    const researcher = agent({ id: 'w1', name: 'Researcher' });
    const state = makeState({ agents: [orchestrator, researcher] });

    vi.spyOn(state.lmStudioClient, 'chat').mockResolvedValue({
      message: { role: 'assistant', content: 'just narrating, no task blocks' }
    });

    const strat = new OrchestratorStrategy();
    
    // Round 1: no progress -> injected SYSTEM nudge
    const r1 = await strat.executeRound(state);
    expect(r1.finalAnswer).toBeUndefined();
    expect(r1.halt).toBeUndefined();
    expect(state.messages[state.messages.length - 1].content).toContain('SYSTEM: You neither delegated a subtask nor gave a final answer.');

    // Round 2: no progress again -> halt
    const r2 = await strat.executeRound(state);
    expect(r2.halt).toBe(true);
    // Should have emitted a System note event
    const events = (state as unknown as { _events: EngineEvent[] })._events;
    expect(events.some(e => e.type === RunEventType.System && (e.payload.note as string).includes('no progress'))).toBe(true);
  });

  it('duplicate detection: identical output twice triggers no-progress guard', async () => {
    const orchestrator = agent({ id: 'o', name: 'Boss', isOrchestrator: true });
    const researcher = agent({ id: 'w1', name: 'Researcher' });
    const state = makeState({ agents: [orchestrator, researcher] });

    vi.spyOn(state.lmStudioClient, 'chat').mockResolvedValue({
      message: { role: 'assistant', content: '<task agent="Researcher">do it</task>' }
    });

    const strat = new OrchestratorStrategy();
    
    // Round 1: valid delegation
    const r1 = await strat.executeRound(state);
    expect(r1.finalAnswer).toBeUndefined();
    expect(r1.halt).toBeUndefined();

    // Round 2: emits exactly the same delegation block
    const r2 = await strat.executeRound(state);
    expect(r2.halt).toBeUndefined(); // First duplicate = 1st offense (nudge)
    expect(state.messages[state.messages.length - 1].content).toContain('SYSTEM: You neither delegated a subtask nor gave a final answer.');
    
    // Round 3: third identical output -> halt
    const r3 = await strat.executeRound(state);
    expect(r3.halt).toBe(true);
  });

  it('rejects a final answer offered before ever delegating, then halts if it persists', async () => {
    const orchestrator = agent({ id: 'o', name: 'Boss', isOrchestrator: true });
    const researcher = agent({ id: 'w1', name: 'Researcher' });
    const state = makeState({ agents: [orchestrator, researcher] });

    // The orchestrator answers directly, using its own tools/reasoning,
    // without ever emitting a <task> block - exactly the "only Blue ran"
    // regression this guards against.
    vi.spyOn(state.lmStudioClient, 'chat').mockResolvedValue({
      message: { role: 'assistant', content: '<final_answer>I solved it myself</final_answer>' }
    });

    const strat = new OrchestratorStrategy();

    // Round 1: rejected - nudged to delegate instead of answering.
    const r1 = await strat.executeRound(state);
    expect(r1.finalAnswer).toBeUndefined();
    expect(r1.halt).toBeUndefined();
    expect(state.messages[state.messages.length - 1].content).toContain(
      'You provided a final answer without ever delegating to a worker'
    );

    // Round 2: still refuses to delegate -> halts (same safety net as the
    // no-progress guard), rather than looping until maxRounds/timeout.
    const r2 = await strat.executeRound(state);
    expect(r2.halt).toBe(true);
    expect(r2.finalAnswer).toBeUndefined();
  });

  it('accepts a final answer once at least one real delegation has happened', async () => {
    const orchestrator = agent({ id: 'o', name: 'Boss', isOrchestrator: true });
    const researcher = agent({ id: 'w1', name: 'Researcher' });
    const state = makeState({ agents: [orchestrator, researcher] });

    let call = 0;
    vi.spyOn(state.lmStudioClient, 'chat').mockImplementation(async (req: ChatRequest) => {
      const sys = req.messages[0].content;
      if (sys.includes('orchestrator')) {
        call++;
        if (call === 1) {
          return { message: { role: 'assistant', content: '<task agent="Researcher">dig</task>' } };
        }
        return { message: { role: 'assistant', content: '<final_answer>done after delegating</final_answer>' } };
      }
      return { message: { role: 'assistant', content: 'worker output' } };
    });

    const strat = new OrchestratorStrategy();
    const r1 = await strat.executeRound(state);
    expect(r1.finalAnswer).toBeUndefined(); // round 1: real delegation happens

    const r2 = await strat.executeRound(state);
    expect(r2.finalAnswer).toBe('done after delegating'); // round 2: now accepted
  });

  it('does not require delegation when the orchestrator has no workers', async () => {
    const orchestrator = agent({ id: 'o', name: 'Boss', isOrchestrator: true });
    const state = makeState({ agents: [orchestrator] }); // no workers at all

    vi.spyOn(state.lmStudioClient, 'chat').mockResolvedValue({
      message: { role: 'assistant', content: '<final_answer>solo answer</final_answer>' }
    });

    const strat = new OrchestratorStrategy();
    const r1 = await strat.executeRound(state);
    expect(r1.finalAnswer).toBe('solo answer'); // accepted immediately - nothing to delegate to
  });
});

describe('DebateStrategy', () => {
  it('converges when all critics raise no objections', async () => {
    const a1 = agent({ id: 'a1', name: 'One' });
    const a2 = agent({ id: 'a2', name: 'Two' });
    const state = makeState({ agents: [a1, a2], space: { ...makeState().space, strategy: Strategy.Debate } });

    vi.spyOn(state.lmStudioClient, 'chat').mockImplementation(async (req: ChatRequest) => {
      const sys = req.messages[0].content;
      if (sys.includes('Critique the proposals')) {
        return { message: { role: 'assistant', content: 'looks good <no_objections/>' } };
      }
      return { message: { role: 'assistant', content: '<final_answer>agreed plan</final_answer>' } };
    });

    const strat = new DebateStrategy();
    const r = await strat.executeRound(state);
    expect(r.finalAnswer).toBe('agreed plan');
  });

  it('does not converge while an objection stands', async () => {
    const a1 = agent({ id: 'a1', name: 'One' });
    const a2 = agent({ id: 'a2', name: 'Two' });
    const state = makeState({ agents: [a1, a2], space: { ...makeState().space, strategy: Strategy.Debate } });

    vi.spyOn(state.lmStudioClient, 'chat').mockImplementation(async (req: ChatRequest) => {
      const sys = req.messages[0].content;
      if (sys.includes('Critique the proposals')) {
        return { message: { role: 'assistant', content: 'I object: needs more detail' } };
      }
      return { message: { role: 'assistant', content: 'my proposal' } };
    });

    const strat = new DebateStrategy();
    const r = await strat.executeRound(state);
    expect(r.finalAnswer).toBeUndefined();
  });
});

describe('RoundRobinStrategy with tools', () => {
  it('offers tools to the agent and completes on final_answer', async () => {
    const a1 = agent({ id: 'a1', name: 'Solo' });
    const state = makeState({ agents: [a1], tools: [{ type: 'function', function: { name: 'srv__x' } }] });

    const chatSpy = vi.spyOn(state.lmStudioClient, 'chat').mockResolvedValue({
      message: { role: 'assistant', content: '<final_answer>ok</final_answer>' }
    });

    const strat = new RoundRobinStrategy();
    const r = await strat.executeRound(state);
    expect(r.finalAnswer).toBe('ok');
    // tools were passed through to the model
    expect(chatSpy.mock.calls[0][0].tools).toHaveLength(1);
  });
});

describe('RoundRobinStrategy full-cycle behavior', () => {
  it('runs every agent in one executeRound, even if an early agent emits <final_answer>', async () => {
    // Reproduces the Design Thinking bug: the first agent (Empathizer) wrapped
    // its stage-1 handoff in <final_answer>, which used to end the run after
    // one turn. Now the whole cycle must run regardless.
    const stages = ['Empathizer', 'Definer', 'Ideator', 'Prototyper', 'Tester'];
    const agents = stages.map((name, i) => agent({ id: `a${i}`, name }));
    const state = makeState({ agents });

    const spoke: string[] = [];
    vi.spyOn(state.lmStudioClient, 'chat').mockImplementation(async (req: ChatRequest) => {
      const sys = req.messages[0].content;
      const who = stages.find((s) => sys.includes(`named "${s}"`))!;
      spoke.push(who);
      // The first agent prematurely declares final; a later one also concludes.
      if (who === 'Empathizer') return { message: { role: 'assistant', content: '<final_answer>premature</final_answer>' } };
      if (who === 'Tester') return { message: { role: 'assistant', content: '<final_answer>real conclusion</final_answer>' } };
      return { message: { role: 'assistant', content: `${who} did their part` } };
    });

    const strat = new RoundRobinStrategy();
    const r = await strat.executeRound(state);

    // All five stages ran, in order, within the single cycle.
    expect(spoke).toEqual(stages);
    // The last emitter in the cycle wins, not the premature early one.
    expect(r.finalAnswer).toBe('real conclusion');
  });

  it('does not end the run when no agent declares a final answer', async () => {
    const agents = [agent({ id: 'a0', name: 'One' }), agent({ id: 'a1', name: 'Two' })];
    const state = makeState({ agents });
    vi.spyOn(state.lmStudioClient, 'chat').mockResolvedValue({
      message: { role: 'assistant', content: 'still working on it' }
    });

    const strat = new RoundRobinStrategy();
    const r = await strat.executeRound(state);
    expect(r.finalAnswer).toBeUndefined();
    // both agents contributed to the transcript
    expect(state.messages.filter((m) => m.role === 'assistant').length).toBe(2);
  });
});
