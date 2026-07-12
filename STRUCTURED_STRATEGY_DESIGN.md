# StructuredStrategy — Guaranteed Fixed-Sequence Execution + Easy Pipeline Builder

**Companion to**: [DESIGN.md](DESIGN.md) (engine architecture), [ORCHESTRATION_RELIABILITY_PLAN.md](ORCHESTRATION_RELIABILITY_PLAN.md) (the delegation-reliability work this supersedes for fixed-cast presets), and [PRESET_SPACES_IMPLEMENTATION.md](PRESET_SPACES_IMPLEMENTATION.md) (preset data model).

**Revision note**: v2 — extended from "3 presets, single fixed pass" to **all 7 presets**, per explicit direction: *"we should structure all preset"*, then *"convert everything, but let Structured support repeating the whole sequence N times"* when OODA Loop (cyclical) and Debate (converge-until-agreement) turned out to need more than one pass. This is a materially bigger design than v1 — the engine now needs **phases** (sequential steps, or parallel-then-converge steps) that can **repeat**, not just one straight line. Sections below are written against this v2 shape; v1's single-pass design is the special case where cycles=1 and every phase is sequential.

---

## Understanding Summary

- **What**: (A) a fourth coordination strategy, `structured`, built on a **Phase** abstraction — code decides who runs, in what order, whether in parallel, and how many times the whole sequence repeats. No LLM ever decides "who's next." (B) **All 7 presets** convert to it, each mapped to the phase shape that matches its actual methodology (below). (C) A new, radically simpler "Pipeline" builder UI for **linear, single-pass** custom Spaces — the easy 80% case. (D) The Orchestrator strategy's "every worker must be consulted" rule (shipped earlier today) is relaxed back to "at least one delegation," restoring it as the *dynamic* delegation strategy for Spaces where the set of participants genuinely depends on the input (e.g. support triage).
- **Why**: four consecutive real Six Thinking Hats runs failed structurally in different ways — all traced to the same root cause: **the sequence was LLM-decided**. That's true for every Orchestrator-family preset, and cycle/convergence logic that's *currently* code-driven (RoundRobin, Debate) still benefits from unification — one engine concept, one mental model, one thing to test, instead of three strategy classes each reasoning about "who runs" differently.
- **Who**: the user running methodology presets on small local models (where LLM-decided anything is unreliable), and users who want to build their own fixed pipelines without understanding strategies/orchestrators/rounds.
- **Non-goals**: adopting LangGraph/LangChain now; fixing model *content* quality (a weak model writing repetitive or empty text is out of any framework's reach); the *easy builder* covering cyclical/convergent shapes (scoped out — see Decision #13); checkpoint/resume of interrupted runs.

## Assumptions

1. `Agent.position` is still the sequence order within a phase; `isOrchestrator` still marks the optional framer/synthesizer. **No new agent-table columns.**
2. **`Space.maxRounds` is reused as "max cycles"** for structured Spaces (exactly how RoundRobin already uses it for cycles today) — no new Space-table column either. Linear, single-pass presets simply have `maxRounds = 1`.
3. Existing user-created preset Spaces keep their old strategy (presets are copied at creation time); recreating from the gallery picks up the converted preset.
4. Tool/webhook access and temperature/sampling behavior are unchanged (structured runs use the same `AgentCaller`).
5. The easy Pipeline builder only ever produces `cycles=1`, all-sequential pipelines. Cyclical (OODA) and parallel-converging (Debate) shapes are preset-only, or hand-built via the advanced builder — see Decision #13.

---

## Decision Log

| # | Decision | Alternatives considered | Why |
|---|---|---|---|
| 1 | New `Strategy.Structured` + `StructuredStrategy implements AgentStrategy`, built on a **Phase** abstraction (below) | Adopt LangGraph.js; three separate ad-hoc classes | One engine concept covers all 7 methodologies; still no new dependency, still reuses `AgentCaller`/events/streaming untouched |
| 2 | A **Phase** is `{ agents, kind: 'sequential' \| 'parallel', guidance, convergenceCheck? }`; a structured Space's shape is `{ framer?, cyclePhases: Phase[], synthesizer?, cycles }` | Model every preset as a flat list of steps (v1) | OODA needs repetition, Debate needs parallel propose/critique with early-stop — a flat step list can't express either without hacks |
| 3 | `cycles` = `Space.maxRounds`, reused as-is | New `Space.cycles` column | Zero schema migration; RoundRobin already overloads this field for "cycles" today, so the UI label ("Max cycles") and mental model already exist |
| 4 | The synthesizer's (or, if none, the last phase's last agent's) **entire output is the final answer** — no `<final_answer>` tag required | Keep requiring the tag | Removes the single most failure-prone contract for weak local models |
| 5 | `convergenceCheck` is an optional per-phase function checked after that phase runs; if it returns true, the cycle loop stops early (before `cycles` is reached) and goes to synthesis | Always run all `cycles` | Preserves Debate's actual value — stop as soon as critics agree, don't force wasted rounds |
| 6 | Empty step output: one retry with a corrective nudge, then record `(no contribution)` and continue | Fail the run; skip silently | A weak model's one empty response shouldn't kill a multi-step pipeline; recorded honestly in the transcript/PDF |
| 7 | Empty/failed synthesis, or a run that exhausts `cycles` without producing output, falls back to the existing `synthesize()` safety net (`halt: true`) | Fail the run | Reuses the already-tested salvage path |
| 8 | **All 7 presets convert to `structured`** (mapping table below) | Convert only the 3 broken ones (v1) | Explicit direction: one consistent, code-guaranteed engine for every preset, not "3 fixed + 4 legacy" |
| 9 | `RoundRobinStrategy` and `DebateStrategy` classes are **retired** once presets migrate off them — `StructuredStrategy`'s sequential/parallel phases are a strict superset of what they did | Keep them for custom Spaces | If Structured can express everything they could (confirmed by the mapping table), keeping three code paths for the same capability is pure maintenance cost. `Strategy.RoundRobin`/`Strategy.Debate` enum values are kept **only** as a migration path for pre-existing custom Spaces (rendered read-only/deprecated in the builder), not offered for new Spaces |
| 10 | Relax Orchestrator's "ALL workers consulted" rule back to "at least one delegation" | Keep both rules | With every fixed-cast preset off Orchestrator, the all-workers rule only harms its real purpose — dynamic, data-dependent delegation |
| 11 | `round_start` payload gains optional `{ phase, phaseName, cycle, totalCycles }` | No progress indication | Makes the guaranteed structure visible: "Cycle 1 of 2 — Orient" in the feed and PDF |
| 12 | New Pipeline builder is a separate, simpler screen; the existing advanced builder stays for custom Spaces of any shape | Redesign the existing builder | Confirmed by user ("very easy"); two audiences, two screens |
| 13 | **Easy builder is scoped to `cycles=1`, all-sequential only** — no UI for parallel/converging/multi-cycle phases | Expose cycles + phase-kind + convergence in the wizard too | A wizard that explains "sequential vs. parallel phases" and "convergence checks" is not "very easy" anymore — it's the advanced builder with different paint. Cyclical/convergent Spaces stay reachable via presets (Six Hats.. no wait, OODA/Debate) or the advanced builder, which already has the concepts (max rounds, strategy) users would need |
| 14 | Pipeline builder is a veneer: creates a normal Space (strategy=structured, cycles=1) + agents via **existing** IPC channels | New dedicated IPC/schema | Zero new backend surface; everything the easy screen does is already validated/tested plumbing |

---

## Preset → Phase Shape Mapping (all 7)

| Preset | Framer/Synth | Cycle phases | Cycles | Convergence | Notes |
|---|---|---|---|---|---|
| **Six Thinking Hats** | Blue (both) | White, Red, Black, Yellow, Green — 5 sequential single-agent phases | 1 | — | Direct v1 shape |
| **TRIZ** | Coordinator (both) | its workers, sequential | 1 | — | Direct v1 shape |
| **Means-End Analysis** | Coordinator (both) | its workers, sequential | 1 | — | Direct v1 shape |
| **Design Thinking** | none | Empathize, Define, Ideate, Prototype, Test — 5 sequential phases | 1 | — | No framer today (RoundRobin); unchanged agent count. Test's output = final answer |
| **The Core Framework** | none | its 5 stages, sequential | 1 | — | Same shape as Design Thinking |
| **OODA Loop** | none | Observe, Orient, Decide, Act — 4 sequential phases, as ONE repeating group | preset default 2 (was maxRounds via RoundRobin; tune-able same as today) | — | The whole O-O-D-A group repeats; Act's output in the **final** cycle = final answer. This is the actual OODA method — bounded, repeated loops, not one pass |
| **Alternative Approaches (Debate)** | none | `[proposePhase(parallel, all agents), critiquePhase(parallel, all agents, convergenceCheck)]` — ONE repeating group of 2 phases | existing default 8 (ceiling) | `convergenceCheck`: every critique this cycle contains `<no_objections/>` | Near-identical to today's `DebateStrategy` logic, just expressed as phases; stops as soon as the panel agrees, same as today |

Every preset ends up **structurally guaranteed** — no agent can be skipped, repeated unfairly, or bypassed by an LLM's own judgment about who should run.

---

## Design

### 1. Engine — `packages/core/src/engine/strategies/StructuredStrategy.ts` (new)

```ts
interface Phase {
  agents: Agent[];
  kind: 'sequential' | 'parallel';
  guidance: (phaseName: string, cycle: number, totalCycles: number) => string;
  convergenceCheck?: (results: { agent: Agent; content: string }[]) => boolean;
}

interface StructuredShape {
  framer?: Agent;
  cyclePhases: Phase[];
  synthesizer?: Agent;   // usually === framer when both exist
}
```

```
executeRound(state):
  shape   = deriveShape(state.agents, state.space)   // see "deriving the shape" below
  cycles  = state.space.maxRounds                    // reused field
  results = []

  if shape.framer: run framer with "open the session" guidance   (1 call, not counted as a cycle)

  for cycle in 1..cycles:
    for phase in shape.cyclePhases:
      if phase.kind === 'parallel':
        results = Promise.all(phase.agents.map(a => callAgent(a, phase.guidance(...))))
      else:
        for agent of phase.agents: results.push(await callAgent(agent, phase.guidance(...)))
      each empty result → one retry → still empty → "(no contribution)" + System note
      // round_start payload carries { phase: phaseName, cycle, totalCycles: cycles }
    if phase.convergenceCheck?.(thisPhaseResults) → break              // Debate-style early stop
    abort check between phases (state.signal)

  if shape.synthesizer: run synthesizer with "produce the final answer" guidance
  finalAnswer = (synthesizer ?? last phase's last agent)'s output, tags stripped
  finalAnswer non-empty → { finalAnswer } : System note + { halt: true }
```

`callAgent`/events/streaming/temperature are all reused untouched — a Phase is just "one or more `callAgent` calls with a specific guidance string and either awaited in sequence or `Promise.all`'d," which is exactly what `OrchestratorStrategy`'s worker dispatch and `DebateStrategy`'s propose/critique already do internally today.

**Deriving the shape** — no new Space-level "shape" field; instead a **small, explicit per-preset shape table** (5 entries, one per non-trivial preset — Six Hats/TRIZ/Means-End all reduce to the same "framer + N sequential workers + synth" builder function) lives in code alongside `StructuredStrategy`, keyed by `space.presetId`. **Custom Spaces without a presetId** (built via the easy wizard) always get the simple shape: no framer/synth unless the wizard's toggles added an `isOrchestrator` agent, `cycles` hardcoded to 1, all phases sequential — derived directly and trivially from `position` order, matching Decision #13's scope limit.

### 2. Validation — `validateSpaceForPublish`

`structured`: at most one `isOrchestrator` agent, ≥1 non-orchestrator agent (same rule as v1 — covers every row in the mapping table, since framer/synth is always 0-or-1 agents regardless of phase complexity).

### 3. Orchestrator strategy relaxation

Unchanged from v1: remove the "all workers" requirement, restore "at least one delegation" as the only structural gate. Keeps the no-progress/duplicate/halt guards and batching guidance.

### 4. Preset conversion — `presets.json`

All 7 presets' `strategy` field becomes `"structured"`. Agent lists, roles, and prompts are otherwise unchanged for Six Hats/TRIZ/Means-End/Design Thinking/Core Framework (position order already matches intended sequence). OODA and Debate presets keep their existing `maxRounds` values (already meaningful as "cycles" under RoundRobin/Debate today — the semantics carry over exactly).

### 5. Retiring RoundRobin/Debate strategy classes

Per Decision #9: once no preset references them, `RoundRobinStrategy` and `DebateStrategy` are deleted; their tests' *behavioral* assertions move to `StructuredStrategy`'s test file (verifying the same guarantees — full-cycle participation, convergence-stops-early — now under the unified class). The `Strategy` enum keeps `round-robin`/`debate` values so any pre-existing custom Space isn't orphaned, but the builder no longer offers them for new Spaces (both wizard and advanced builder now offer: Pipeline, Structured-custom via advanced, Orchestrator).

### 6. The easy Pipeline builder — UI

Unchanged from v1 (Decision #13 keeps it deliberately simple):

**Entry**: "New Space" opens a chooser — **Pipeline** (recommended, opens the wizard) vs **Custom Space** (advanced, opens today's builder, now including "Structured" as a selectable strategy alongside Orchestrator for anyone who wants cycles/parallel phases by hand).

**`PipelineBuilderScreen.tsx`**: Name → Model dropdown → numbered step cards (role template picker + instructions textarea, reorder arrows, add/remove) → two default-on toggles (framing / synthesis step) → **Create & Publish**. Always `cycles=1`, always sequential. Identical to v1's section 5 design.

**Run screen/PDF**: `RunFeed` and the PDF card header show `"Cycle {c}/{C} — {phase}"` when the payload carries cycle info (omitted when `totalCycles === 1`, i.e. every linear preset and every wizard-built pipeline — so the common case stays visually identical to v1's "Step n of N").

---

## What This Fixes, Concretely

| Observed failure (real runs) | Under StructuredStrategy |
|---|---|
| Only Blue ran, 8 turns | Impossible — the loop calls every phase |
| Blue answered without delegating | Impossible — synthesis only exists after every phase has run |
| One hat consulted 3×, others skipped | Impossible — exactly once each (per cycle), in order |
| Burned rounds re-delegating → "max rounds reached" | No delegation exists to burn rounds on |
| OODA/Debate losing their repeat/converge nature (the risk in v1) | Preserved explicitly — cycles + convergenceCheck are first-class, not bolted on |
| All hats returned identical output | *Mitigated, not fixed* — model-quality issue, out of scope for any orchestration design |

---

## Test Plan

- **`strategies.test.ts` (StructuredStrategy)**:
  - Linear shape (Six Hats-style): framer → workers in position order → synthesizer, each exactly once; synthesizer's whole output = `finalAnswer`, tags stripped.
  - Cyclical shape (OODA-style): the 4-phase group repeats exactly `cycles` times; last cycle's last phase = `finalAnswer`; a lower `cycles` value visibly runs fewer repetitions (spy on call count).
  - Converging shape (Debate-style): propose→critique repeats; a critique phase where every result matches the convergence check stops the loop **before** `cycles` is reached; a non-converging run runs the full `cycles` and then synthesizes/halts.
  - Empty step → retry → `(no contribution)`, run continues; empty synthesis → `{halt:true}`; no-framer shape uses last phase's last agent's output; abort mid-run throws 'Run stopped'.
- **`engine.test.ts`**: end-to-end run for each of the three *shapes* (linear/cyclical/converging) persists correctly ordered `round_start` events with `{phase, cycle, totalCycles}`, completes with zero reliance on any tag.
- **`validation.test.ts`**: unchanged from v1 (0-or-1 orchestrator rule covers all shapes).
- **`presetWorkflows.test.ts`**: **all 7** presets complete, every agent participates, under a mock that never emits `<task>`/delegation tags — this is the headline regression suite, now covering the full preset catalog instead of 3.
- **`spacePresets.test.ts`**: strategy assertions updated to `structured` for all 7; orchestrator-conflict-prose checks retargeted/removed as appropriate.
- **Retirement**: `RoundRobinStrategy`/`DebateStrategy` test files removed only after their behavioral coverage is confirmed present in `StructuredStrategy`'s suite (no coverage gap).
- **UI**: manual verification per session convention — pipeline create→publish→run→PDF; chooser; advanced builder can still build/open cyclical & converging structured Spaces by hand.

## Implementation Order

1. `Phase`/`StructuredShape` types + `StructuredStrategy` engine core (linear shape only) + unit tests — mirrors v1's scope, gets the 3 broken presets fixed fastest.
2. Extend `StructuredStrategy` with cycles + parallel phases + convergence; unit tests for OODA/Debate shapes.
3. Validation rule + `RunOrchestrator` wiring + engine/e2e tests for all three shapes.
4. Convert all 7 presets; run `presetWorkflows.test.ts` against the full catalog (locks in the regression fix).
5. Retire `RoundRobinStrategy`/`DebateStrategy` once coverage is confirmed migrated.
6. Orchestrator relaxation + test updates.
7. Pipeline builder UI + chooser + feed/PDF phase/cycle annotation.
8. Full `npm run verify`, app relaunch, manual re-run of the Six Hats scenarios that failed, plus one OODA and one Debate run to confirm cycling/convergence still behave as before.

## Acceptance Criteria

- Re-running a Six Hats problem: all six hats run exactly once, in order, synthesis by Blue, no reliance on any tag.
- Re-running an OODA Loop problem: the 4-stage group visibly repeats the configured number of cycles, each cycle building on the last.
- Re-running a Debate problem: propose→critique repeats until every critic agrees (or the cycle ceiling), exactly as today, just via the unified engine.
- A user builds and publishes a working 3-step linear pipeline from the new wizard in under a minute.
- A support-triage-style Orchestrator Space still works with the all-workers rule removed.
- `npm run verify` green; no coverage regression from retiring `RoundRobinStrategy`/`DebateStrategy`.
