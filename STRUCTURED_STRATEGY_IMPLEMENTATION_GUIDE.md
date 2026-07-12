# StructuredStrategy — Step-by-Step Implementation Guide

**Implements**: [STRUCTURED_STRATEGY_DESIGN.md](STRUCTURED_STRATEGY_DESIGN.md) (v2 — all 7 presets, Phase abstraction). Read that first for the *why*; this document is the *how*, concrete enough to follow without further design decisions.

**Audience**: any developer with the repo checked out. Every step lists exact files, full code, tests, and a verification command. Do the steps in order — each builds on the last and leaves the suite green.

---

## 0. Prerequisites & operational notes (read once)

**Repo shape**: npm workspaces monorepo. `@acs/core` (engine, Electron-free) and `@acs/desktop` (Electron). Desktop imports `@acs/core` from its **built `dist/`**, not source.

**Three commands you will run constantly:**

| Command | When |
|---|---|
| `npm run build --workspace @acs/core` | **After every `@acs/core` change, before typechecking/using desktop.** Desktop typechecks against core's `dist/`; skip this and you'll see phantom "property does not exist" errors. |
| `npx vitest run <file>` | Run one test file fast during a step. |
| `npm run verify` | Full gate: lint + typecheck + build + all tests. Run at the end of each step. |

**The better-sqlite3 ABI gotcha** (you *will* hit this): tests run under system Node; the Electron app needs an Electron-ABI build of the native module. They use different ABIs.
- Before running **tests**: `npm rebuild better-sqlite3` (and make sure the Electron app is **closed**, or the `.node` file is locked → rebuild fails).
- Before launching the **app**: `cd packages/desktop && npx electron-rebuild -f -w better-sqlite3`.
- Symptom of wrong ABI: `NODE_MODULE_VERSION 123 ... requires 127` on every DB-touching test.

**Line endings**: the repo is LF; git warns "LF will be replaced by CRLF" on Windows — harmless, ignore.

**Commit discipline**: `git status -s` and stage only intended files; never `git add -A`. There are several uncommitted design/plan `.md` files in the tree — do not sweep them into code commits.

---

## Step 1 — Add the `Structured` enum value and the strategy's public types

### 1.1 `packages/core/src/domain/enums.ts`

```ts
export enum Strategy {
  Orchestrator = 'orchestrator',
  RoundRobin = 'round-robin',
  Debate = 'debate',
  Structured = 'structured'
}
```

> Keep `RoundRobin`/`Debate` — they remain valid values so pre-existing custom Spaces on those strategies are not orphaned after we retire their *classes* in Step 9.

### 1.2 New file `packages/core/src/engine/strategies/StructuredTypes.ts`

```ts
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
```

### 1.3 Verify

```bash
npm run build --workspace @acs/core
```
Expect a clean build (no test yet — types only).

---

## Step 2 — Let `callAgent` stamp phase metadata onto `round_start`

The feed/PDF need to show "Cycle 1/2 — Orient". `callAgent` is the single place `round_start` is emitted, so add an optional metadata param there. **Backward compatible** — every existing caller omits it.

### 2.1 `packages/core/src/engine/strategies/AgentCaller.ts`

Change the signature and the one `round_start` emission:

```ts
export async function callAgent(
  state: ExecutionState,
  agent: Agent,
  messages: ChatMessage[],
  roundStartMeta?: Record<string, unknown>   // NEW
): Promise<ChatMessage> {
  const model = agent.modelId || state.space.defaultModel;
  state.onEvent({
    type: RunEventType.RoundStart,
    agentId: agent.id,
    payload: { model, ...roundStartMeta }    // CHANGED: spread meta
  });
  // ... rest unchanged
```

### 2.2 Verify

```bash
npm run build --workspace @acs/core && npx vitest run packages/core/src/engine
```
Existing engine + strategy tests must still pass (nothing passes the new arg yet, so behavior is identical).

---

## Step 3 — `StructuredStrategy` core (linear shape only)

This is the heart. New file `packages/core/src/engine/strategies/StructuredStrategy.ts`.

```ts
import { Agent } from '../../domain/types.js';
import { RunEventType } from '../../domain/enums.js';
import { AgentStrategy, ExecutionState } from './AgentStrategy.js';
import { buildAgentMessages, callAgent, extractFinalAnswer } from './AgentCaller.js';
import { Phase, PhaseContext, StructuredShape } from './StructuredTypes.js';

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
```

### 3.1 Unit tests — new file `packages/core/src/engine/strategies/structured.test.ts`

Follow the exact `makeState`/`agent` helper pattern already in `strategies.test.ts` (copy those two helpers up top; they build an `ExecutionState` with a fake `LmStudioClient` and an `_events` capture array).

```ts
import { describe, it, expect, vi } from 'vitest';
import { LmStudioClient, ConcurrencyLimiter, ChatMessage, ChatRequest } from '../../llm/index.js';
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
const roleReply = (role: string) => `contribution from ${role}`;

describe('StructuredStrategy — linear', () => {
  it('runs framer -> each worker once in order -> synthesizer, and returns the synthesis as the answer', async () => {
    const blue = agent({ id: 'o', name: 'Blue', role: 'Blue Hat', isOrchestrator: true });
    const white = agent({ id: 'w1', name: 'White', role: 'White Hat', position: 1 });
    const black = agent({ id: 'w2', name: 'Black', role: 'Black Hat', position: 2 });
    const state = makeState({ agents: [blue, white, black] });

    const callOrder: string[] = [];
    vi.spyOn(state.lmStudioClient, 'chat').mockImplementation(async (req: ChatRequest) => {
      const sys = req.messages[0].content;
      const who = sys.includes('opening this session') ? 'frame'
        : sys.includes('final answer') ? 'synth'
        : sys.match(/named "(\w+)"/)?.[1] ?? '?';
      callOrder.push(who);
      return { message: { role: 'assistant', content: who === 'synth' ? 'THE FINAL ANSWER' : roleReply(who) } };
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
      message: { role: 'assistant', content: '<final_answer>last word</final_answer>' }
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
      return { message: { role: 'assistant', content: n <= 2 ? '' : 'ignored' } }; // both attempts empty
    });
    const shape: StructuredShape = {
      cyclePhases: [{ name: 'P', kind: 'sequential', agents: [a1], guidance: () => 'go' }]
    };
    const r = await new StructuredStrategy(shape).executeRound(state);
    expect(n).toBe(2); // one call + one retry
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
```

### 3.2 Verify

```bash
npm run build --workspace @acs/core && npx vitest run packages/core/src/engine/strategies/structured.test.ts
```

---

## Step 4 — Cycles, parallel phases, and convergence (OODA + Debate shapes)

The Step 3 code **already implements** the cycle loop, `parallel` kind, and `convergenceCheck`. This step only adds **tests** proving those paths, so you don't ship them untested.

Append to `structured.test.ts`:

```ts
describe('StructuredStrategy — cyclical & converging', () => {
  it('repeats the cycle group exactly `maxRounds` times (OODA)', async () => {
    const o = agent({ id: 'o', name: 'Obs', role: 'Observe', position: 1 });
    const d = agent({ id: 'd', name: 'Dec', role: 'Decide', position: 2 });
    const state = makeState({ agents: [o, d], space: { ...makeState().space, maxRounds: 3 } });
    let calls = 0;
    vi.spyOn(state.lmStudioClient, 'chat').mockImplementation(async () => {
      calls++; return { message: { role: 'assistant', content: `c${calls}` } };
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
      const isCritique = req.messages.some((m) => m.content.includes('CRITIQUE_PHASE'));
      if (isCritique) return { message: { role: 'assistant', content: '<no_objections/>' } }; // converge on 1st critique
      round++;
      return { message: { role: 'assistant', content: 'a proposal' } };
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
```

### 4.1 Verify

```bash
npx vitest run packages/core/src/engine/strategies/structured.test.ts
```

---

## Step 5 — Shape derivation (`deriveShape`) keyed by preset

`RunOrchestrator` needs to turn a Space + its agents into a `StructuredShape`. Put this next to the strategy so the mapping table lives with the code that uses it.

### 5.1 New file `packages/core/src/engine/strategies/structuredShapes.ts`

```ts
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
```

### 5.2 Export both new modules — `packages/core/src/engine/strategies/index.ts`

```ts
export * from './AgentStrategy.js';
export * from './AgentCaller.js';
export * from './OrchestratorStrategy.js';
export * from './RoundRobinStrategy.js';   // removed in Step 9
export * from './DebateStrategy.js';        // removed in Step 9
export * from './StructuredTypes.js';
export * from './StructuredStrategy.js';
export * from './structuredShapes.js';
```

### 5.3 Verify

```bash
npm run build --workspace @acs/core
```

---

## Step 6 — Wire `StructuredStrategy` into `RunOrchestrator`

### 6.1 `packages/core/src/engine/RunOrchestrator.ts`

`createStrategy` currently takes only the strategy enum. Structured needs the space+agents to derive its shape. Change the call site and the method:

```ts
// in the constructor, where strategy is created:
this.strategy = this.createStrategy(space, agents);
```

```ts
import { StructuredStrategy, deriveStructuredShape } from './strategies/index.js';
// ...
private createStrategy(space: Space, agents: Agent[]): AgentStrategy {
  switch (space.strategy) {
    case Strategy.Orchestrator: return new OrchestratorStrategy();
    case Strategy.RoundRobin:   return new RoundRobinStrategy();   // removed in Step 9
    case Strategy.Debate:       return new DebateStrategy();        // removed in Step 9
    case Strategy.Structured:   return new StructuredStrategy(deriveStructuredShape(space, agents));
    default: throw new Error(`Unknown strategy ${space.strategy}`);
  }
}
```

> The run loop (`while roundsUsed < maxRounds`) is **not** changed. `StructuredStrategy.executeRound` does the entire run internally (all cycles) and returns `{ finalAnswer }` or `{ halt: true }`, so the loop exits after one iteration — exactly like a strategy that finishes in round 1 today.

### 6.2 End-to-end test — append to `packages/core/src/engine/engine.test.ts`

```ts
it('runs a structured Space to completion with every agent participating and no tags', async () => {
  const lmClient = new LmStudioClient();
  vi.spyOn(lmClient, 'listModels').mockResolvedValue(['m']);
  const ran = new Set<string>();
  vi.spyOn(lmClient, 'chat').mockImplementation(async (req) => {
    const name = req.messages[0].content.match(/named "(\w+)"/)?.[1] ?? '?';
    ran.add(name);
    return { message: { role: 'assistant', content: `text from ${name}` } }; // NB: never emits <final_answer>
  });

  const space = mkSpace({ strategy: Strategy.Structured, maxRounds: 1, presetId: undefined });
  const run = { id: 'r1', spaceId: 's1', problem: 'q', status: RunStatus.Running, roundsUsed: 0, startedAt: Date.now() };
  const agents = [
    { id: 'o', spaceId: 's1', name: 'Lead', role: 'Lead', systemPrompt: 'L', isOrchestrator: true, position: 0 },
    { id: 'w1', spaceId: 's1', name: 'Alpha', role: 'Alpha', systemPrompt: 'A', isOrchestrator: false, position: 1 },
    { id: 'w2', spaceId: 's1', name: 'Beta', role: 'Beta', systemPrompt: 'B', isOrchestrator: false, position: 2 }
  ];
  spaceRepo.create(space); runRepo.create(run);

  const engine = new RunOrchestrator(run, space, agents, [], [], runRepo, eventRepo, lmClient, new ConcurrencyLimiter(1));
  await engine.start();

  expect(ran.has('Alpha')).toBe(true);
  expect(ran.has('Beta')).toBe(true);   // no agent skipped
  expect(runRepo.get('r1')?.status).toBe(RunStatus.Completed);
  expect(runRepo.get('r1')?.finalAnswer).toBeTruthy(); // completed with no tag anywhere
});
```

> `mkSpace` in `engine.test.ts` spreads overrides, so `presetId: undefined` and `strategy` work. If `mkSpace` doesn't currently accept `presetId`, it will via the `...over` spread — confirm the helper spreads overrides (it does today).

### 6.3 Verify

```bash
npm rebuild better-sqlite3   # ensure Node ABI (app closed)
npm run build --workspace @acs/core && npx vitest run packages/core/src/engine/engine.test.ts
```

---

## Step 7 — Publish validation for `structured`

### 7.1 `packages/core/src/domain/validation.ts`

Inside `validateSpaceForPublish`, add a branch (keep the existing Orchestrator/else branches):

```ts
if (space.strategy === Strategy.Structured) {
  const workers = agents.filter((a) => !a.isOrchestrator);
  if (orchestrators.length > 1) {
    issues.push({ field: 'strategy', message: 'A structured Space may have at most one framer/synthesizer agent.' });
  }
  if (workers.length === 0) {
    issues.push({ field: 'strategy', message: 'A structured Space needs at least one non-framer agent.' });
  }
}
```

Make sure this is reached for structured (the current code has `if (Orchestrator) {...} else {...}` where the `else` forbids any orchestrator — structured must **not** fall into that `else`). Restructure to:

```ts
if (space.strategy === Strategy.Orchestrator) { /* existing exactly-one rule */ }
else if (space.strategy === Strategy.Structured) { /* the block above */ }
else { /* existing "no orchestrator allowed" rule for round-robin/debate */ }
```

### 7.2 Tests — append to `packages/core/src/domain/validation.test.ts`

```ts
it('structured: accepts 0 or 1 framer with >=1 worker, rejects 2 framers or 0 workers', () => {
  const sp = mkSpace(Strategy.Structured);
  expect(validateSpaceForPublish(sp, [mkAgent({ id: 'a1' })])).toEqual([]); // 0 framers, 1 worker
  expect(validateSpaceForPublish(sp, [mkAgent({ id: 'a1', isOrchestrator: true }), mkAgent({ id: 'a2' })])).toEqual([]); // 1 framer + worker
  expect(validateSpaceForPublish(sp, [mkAgent({ id: 'a1', isOrchestrator: true })]).length).toBeGreaterThan(0); // no worker
  expect(validateSpaceForPublish(sp, [
    mkAgent({ id: 'a1', isOrchestrator: true }), mkAgent({ id: 'a2', isOrchestrator: true }), mkAgent({ id: 'a3' })
  ]).length).toBeGreaterThan(0); // 2 framers
});
```
(Reuse the `mkSpace`/`mkAgent` helpers already at the top of that test file; `mkSpace` takes a strategy arg.)

### 7.3 Verify

```bash
npm run build --workspace @acs/core && npx vitest run packages/core/src/domain/validation.test.ts
```

---

## Step 8 — Convert all 7 presets in `presets.json`

File: `packages/core/src/presets/presets.json`. For each preset object:

| Preset id | Set `strategy` | Set `maxRounds` | Notes |
|---|---|---|---|
| `six-thinking-hats` | `"structured"` | `1` | Blue keeps `isOrchestrator: true` (now = framer+synth). Ensure hat order in the array is Blue, White, Red, Black, Yellow, Green (position = array index). |
| `triz` | `"structured"` | `1` | Coordinator keeps `isOrchestrator: true`. |
| `means-end-analysis` | `"structured"` | `1` | Coordinator keeps `isOrchestrator: true`. |
| `design-thinking` | `"structured"` | `1` | No orchestrator agent (unchanged). Order = Empathize→Define→Ideate→Prototype→Test. |
| `the-core-framework` | `"structured"` | `1` | No orchestrator agent. Stage order preserved. |
| `ooda-loop` | `"structured"` | keep (e.g. `2`) | No orchestrator agent. `maxRounds` now = cycle count; keep the current value. Order = Observe→Orient→Decide→Act. |
| `alternative-approaches` | `"structured"` | keep (e.g. `8`) | Debate shape. `maxRounds` = propose/critique cycle ceiling. |

**Prompt cleanup** (linear-with-framer presets only — Six Hats, TRIZ, Means-End): in each orchestrator agent's `systemPrompt`, replace any lingering delegation-mechanic phrasing ("delegating directives", "<task agent=...>", "using the delegation format the system specifies") with role-pure wording, e.g.:
> "You open the session by framing the problem, and at the end you synthesize all contributions into the final decision. You do not direct the others — each contributes automatically in turn."

Leave White/Red/etc. worker prompts untouched.

### 8.1 The headline regression test — `packages/core/src/presets/presetWorkflows.test.ts`

This file already loops all presets and runs each engine end-to-end. Update its fake model so it **never emits `<task>` or delegation tags** (the exact weak-model behavior that broke real runs) — just returns role-flavored text — and assert every preset completes with every agent having produced a `round_start`. Because presets are now `structured`, this must pass without any tag cooperation:

```ts
// inside the per-preset loop, replace the chat mock body with:
vi.spyOn(lmClient, 'chat').mockImplementation(async (req) => {
  const name = req.messages[0].content.match(/named "([^"]+)"/)?.[1] ?? 'agent';
  // Debate needs the convergence signal or it runs all cycles (still fine, just slower):
  const isCritique = req.messages.some((m) => typeof m.content === 'string' && m.content.includes('<no_objections/>'));
  return { message: { role: 'assistant', content: isCritique ? '<no_objections/>' : `perspective from ${name}` } };
});
// then assert: every agent id appears in a round_start event, and run status === Completed.
```

### 8.2 Update `spacePresets.test.ts`

Any assertion that a preset's `strategy` equals `orchestrator`/`round-robin`/`debate` becomes `structured`. Remove/retarget the "orchestrator prompt has no prose-delegation examples" checks for the converted presets (they no longer delegate at all).

### 8.3 Verify

```bash
npm run build --workspace @acs/core && npx vitest run packages/core/src/presets
```

---

## Step 9 — Retire `RoundRobinStrategy` and `DebateStrategy` classes

Only after Step 8 is green (no preset references them).

1. Confirm the behavioral guarantees they had are now covered by `structured.test.ts` (full-cycle participation → the OODA cycle test; converge-on-agreement → the Debate test). If any assertion is unique to the old files, port it into `structured.test.ts` first.
2. Delete `packages/core/src/engine/strategies/RoundRobinStrategy.ts` and `DebateStrategy.ts`, and their test files.
3. Remove their `export * from` lines in `strategies/index.ts` and their `case` lines in `RunOrchestrator.createStrategy`.
4. **Keep** `Strategy.RoundRobin`/`Strategy.Debate` enum values (pre-existing custom Spaces on them must still load) — but `createStrategy`'s `default` now throws for them, which is fine *only if* no such Space exists. Safer: map both remaining enum values to a structured shape at load:

```ts
case Strategy.RoundRobin:
case Strategy.Debate:
case Strategy.Structured:
  return new StructuredStrategy(deriveStructuredShape(space, agents));
```
(`deriveStructuredShape` for a no-preset round-robin Space yields a linear pipeline — a reasonable, non-crashing interpretation of a legacy Space.)

### 9.1 Verify

```bash
npm run build --workspace @acs/core && npx vitest run packages/core
```

---

## Step 10 — Relax the Orchestrator "all workers" rule

`packages/core/src/engine/strategies/OrchestratorStrategy.ts`: revert the `delegatedWorkerIds` (all-workers) gate back to a single boolean "has any delegation happened."

- Replace `private delegatedWorkerIds = new Set<string>()` with `private hasDelegated = false`.
- `remainingWorkers` logic and the "not consulted yet" nudge branch: delete.
- Premature-final-answer test = `!!finalAnswer && workers.length > 0 && !this.hasDelegated` (the earlier, simpler form).
- After a successful dispatch with ≥1 real worker: `this.hasDelegated = true`.
- Restore the earlier nudge text ("You provided a final answer without ever delegating to a worker...").

Update `strategies.test.ts`: the "rejects until EVERY worker consulted" test becomes "rejects until at least one delegation, then accepts" (this earlier test already exists in git history — restore its assertions). Keep the batching guidance in the planner prompt.

### 10.1 Verify

```bash
npm run build --workspace @acs/core && npx vitest run packages/core/src/engine/strategies/strategies.test.ts
```

---

## Step 11 — The UI (desktop)

### 11.1 Route + chooser

`packages/desktop/src/renderer/src/view.ts` — add two views:
```ts
| { name: 'newSpaceChooser' }
| { name: 'pipeline' }
```
`topLevelFor`: both map to `'spaces'`.

`packages/desktop/src/renderer/src/App.tsx` — in the `switch (view.name)`:
- `'newSpaceChooser'` → renders a small chooser component (two big cards: **Pipeline** → `setView({name:'pipeline'})`, **Custom Space** → `setView({name:'builder', spaceId:null})`).
- `'pipeline'` → `<PipelineBuilderScreen onDone={(id) => setView({name:'run', spaceId:id})} onBack={() => setView({name:'spaces'})} />`.

`SpacesHomeScreen.tsx` — the **New Space** button now calls `onNewSpace()` → `setView({name:'newSpaceChooser'})` instead of going straight to the builder (thread a new prop through `App.tsx`).

### 11.2 `packages/desktop/src/renderer/src/screens/PipelineBuilderScreen.tsx` (new)

State: `name`, `defaultModel`, `models[]` (+ `loadModels()` copied from `SettingsScreen.tsx` — same `window.acs.models.list(baseUrl)` pattern, but here just `models.list()` default URL is fine), `steps: {role, systemPrompt}[]`, `frame: boolean` (default true), `synth: boolean` (default true).

Render, top to bottom:
1. Name text input.
2. Model `<select>` + Refresh (mirror `SettingsScreen`'s dropdown incl. the "(Offline)" fallback option and error hint).
3. Steps: `steps.map(...)` → a card per step with a **Role** input (+ the role-template `<select>` from `AgentEditor.tsx` to prefill `role`+`systemPrompt`), an **Instructions** `<textarea>`, ↑/↓ (swap with neighbor), ✕ (remove). A **"+ Add step"** button pushes `{role:'', systemPrompt:''}`.
4. Two checkboxes: "Start with a framing step", "End with a synthesis step".
5. **Create & Publish** button → `createAndPublish()`.

`createAndPublish()` (all via existing IPC — no new channels):
```ts
async function createAndPublish() {
  // 1. create the Space
  const space = await call(window.acs.spaces.create({
    name, strategy: 'structured' as Space['strategy'], defaultModel, maxRounds: 1
  }));
  // 2. build the agent list: optional framer first (isOrchestrator), then steps
  let pos = 0;
  const wantsFramer = frame || synth; // one isOrchestrator agent covers both ends
  if (wantsFramer) {
    await call(window.acs.agents.create({
      spaceId: space.id, name: 'Facilitator', role: 'Facilitator',
      systemPrompt: 'You frame the problem at the start and synthesize the final answer at the end.',
      isOrchestrator: true, position: pos++
    }));
  }
  for (const s of steps) {
    await call(window.acs.agents.create({
      spaceId: space.id, name: s.role || `Step ${pos}`, role: s.role || `Step ${pos}`,
      systemPrompt: s.systemPrompt, isOrchestrator: false, position: pos++
    }));
  }
  // 3. publish, then go to run
  const res = await call(window.acs.spaces.publish(space.id));
  if (!res.success) { setError(res.issues.map(i => i.message).join('; ')); return; }
  onDone(space.id);
}
```
Inline-validate: require a name, a model, and ≥1 step before enabling the button.

> Note the framer/synth simplification: one `isOrchestrator` "Facilitator" agent serves as both framer and synthesizer (matching `linearWithFramer`, where `framer === synthesizer`). If **both** toggles are off, create no orchestrator agent → `linearNoFramer` (last step's output is the answer). If only one toggle is on, you still create the single Facilitator (it runs at both ends); a future refinement could support frame-only/synth-only, but that's out of scope (Decision #13 keeps this minimal).

### 11.3 Advanced builder: expose `structured`

`SpaceBuilderScreen.tsx` — add `{ value: 'structured', label: 'Structured pipeline', hint: 'Agents run in a fixed, code-guaranteed order (optionally repeating). No LLM decides who goes next.' }` to the `STRATEGIES` array so power users can hand-build structured Spaces (incl. setting Max rounds = cycles). A structured preset Space opens here fine and shows the strategy locked, same as today.

### 11.4 Feed + PDF: show "Cycle c/C — phase"

`packages/desktop/src/renderer/src/components/RunFeed.tsx` — the `round_start` payload now may carry `{ phase, cycle, totalCycles }`. In `buildFeed`, read them onto the `Turn`; in the turn header render, when `totalCycles > 1` show `` `Cycle ${cycle}/${totalCycles} · ${phase}` `` next to the agent role. When `totalCycles === 1` (every linear preset + every wizard pipeline), show nothing extra — the common case looks exactly as it does today.

`packages/core/src/report/ReportRenderer.ts` — the per-turn card header can optionally append the same phase/cycle string (read from the `round_start` payload while grouping). Optional polish; skip if you want the smallest diff.

### 11.5 Verify (UI is manual per repo convention)

```bash
npm run build --workspace @acs/core
cd packages/desktop && npx tsc --noEmit -p tsconfig.json   # renderer typechecks
```
Then rebuild for Electron and launch (Step 12).

---

## Step 12 — Full gate + manual verification

```bash
# tests use Node ABI; ensure the app is closed first
npm rebuild better-sqlite3
npm run verify        # lint + typecheck + build + all tests — must be exit 0
```

Then launch and manually confirm the acceptance criteria:

```bash
cd packages/desktop && npx electron-rebuild -f -w better-sqlite3
npm run dev
```

**Manual checklist** (matches the design's acceptance criteria):
1. Spaces → New Space → chooser appears → **Pipeline** → build a 3-step pipeline (name, model, 3 roles) → Create & Publish → lands on Run → run a problem → **all 3 steps run in order**, completes with the synthesizer's answer, PDF opens.
2. Recreate **Six Thinking Hats** from the gallery → run the traffic problem → **all six hats run exactly once, in order**, even though the model emits no tags; final answer is Blue's synthesis; no "max rounds reached" note.
3. Recreate **OODA Loop** → run → the four stages visibly repeat for the configured cycles ("Cycle 1/2 …", "Cycle 2/2 …").
4. Recreate **Alternative Approaches** → run → propose/critique repeats and stops when critics agree.
5. An **Orchestrator** custom Space (build one: 1 orchestrator + 3 specialists) still returns an answer after consulting only the specialists it chose — the all-workers rule is gone.

---

## Commit plan (suggested)

Land in reviewable chunks, each green on its own:
1. `feat(engine): StructuredStrategy + Phase types + shape derivation` (Steps 1–6)
2. `feat(engine): structured publish validation` (Step 7)
3. `feat(presets): convert all 7 presets to structured` (Step 8)
4. `refactor(engine): retire RoundRobin/Debate strategy classes` (Step 9)
5. `fix(engine): relax Orchestrator to require only one delegation` (Step 10)
6. `feat(ui): pipeline builder, new-space chooser, cycle/phase feed labels` (Step 11)

Each commit: `git status -s`, stage only that step's files, `npm run verify` before pushing, confirm `HEAD == origin/main` after.

---

## Appendix — Quick reference of every file touched

**New**: `StructuredTypes.ts`, `StructuredStrategy.ts`, `structuredShapes.ts`, `structured.test.ts` (core); `PipelineBuilderScreen.tsx` + a small chooser (desktop).
**Edited (core)**: `domain/enums.ts`, `engine/strategies/AgentCaller.ts`, `engine/strategies/index.ts`, `engine/RunOrchestrator.ts`, `domain/validation.ts`, `engine/strategies/OrchestratorStrategy.ts`, `presets/presets.json`; tests: `engine.test.ts`, `validation.test.ts`, `presetWorkflows.test.ts`, `spacePresets.test.ts`, `strategies.test.ts`.
**Deleted (core)**: `RoundRobinStrategy.ts`, `DebateStrategy.ts` (+ their tests).
**Edited (desktop)**: `renderer/src/view.ts`, `renderer/src/App.tsx`, `renderer/src/screens/SpacesHomeScreen.tsx`, `renderer/src/screens/SpaceBuilderScreen.tsx`, `renderer/src/components/RunFeed.tsx`; optional `packages/core/src/report/ReportRenderer.ts`.
