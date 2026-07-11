import { describe, it, expect, vi } from 'vitest';
import { LmStudioClient, ConcurrencyLimiter, ChatMessage, ChatRequest } from '../../llm/index.js';
import { Strategy, SpaceStatus, RunStatus } from '../../domain/enums.js';
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
  it('extracts agent name + task from task tags', () => {
    const out = parseTaskAssignments(
      'plan: <task agent="Researcher">find sources</task> and <task agent="Writer">draft it</task>'
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
