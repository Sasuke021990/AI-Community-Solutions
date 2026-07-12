# Orchestration Reliability & Sampling Controls — Implementation Plan

**Companion to**: [DESIGN.md](DESIGN.md) (engine architecture), [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) Phase 4 (coordination strategies), and [PRESET_SPACES_IMPLEMENTATION.md](PRESET_SPACES_IMPLEMENTATION.md) (preset data). This plan fixes a confirmed production failure in the Orchestrator strategy and adds sampling controls to improve local-model instruction-following.

---

## Understanding Summary

- **What**: (A) fix the Orchestrator coordination strategy so worker agents actually run; (B) add low-temperature + frequency-penalty sampling so local models follow the structured delegation/tool protocol reliably; (C) make model timeouts degrade gracefully into a partial answer + PDF instead of a bare failure, and make report availability unmistakable; and validate that all 7 preset workflows work.
- **Why**: a real run (`Six Thinking Hats`, problem "how to control indina population?") failed after ~24 minutes with `Model overall timeout exceeded (600000ms)`, having run **8 turns that were all the Blue/orchestrator agent** — no worker hat ever ran, the model got stuck emitting byte-identical output before a single generation blew the 10-minute per-call cap, and (as reported) the run appeared to yield no usable PDF.
- **Where**: `@acs/core` engine (`OrchestratorStrategy`, `AgentCaller`, `RunOrchestrator`), the preset data (`presets.json`), the LLM request type, the desktop `RunManager`/`RunScreen`, and a small per-Space setting surfaced in the desktop UI.
- **Non-goals**: rewriting the delegation protocol to something other than `<task>` tags; per-agent temperature; changing RoundRobin/Debate coordination *logic* (they don't delegate, so they're unaffected by the delegation fixes — but they benefit from the sampling and timeout-salvage changes); removing the 600 s overall-timeout backstop.

## Evidence (from the actual failed run, read out of the app's SQLite DB)

| Fact | Value |
|---|---|
| Run status / error | `failed` — `Model overall timeout exceeded (600000ms)` |
| Rounds used | 7 completed + a timed-out 8th (~24 min wall clock) |
| Turns by agent | **8 turns, all Blue** — White/Red/Black/Yellow/Green: **0 turns each** |
| `<task agent="…">` blocks emitted by Blue | **0** (across all 8 turns) |
| `<final_answer>` emitted | **0** |
| Repetition | seq 19, 21, 23 were **byte-identical** 9,466-char outputs (same SHA-1) |
| Final call | streamed for exactly **600 s** then hit the overall cap |
| PDF | **was** generated (contains only Blue's cards, so it looked empty) |

## Root Causes

1. **Instruction conflict.** The orchestrator's preset prompt tells it to delegate in *prose* (Blue: *"brief process directions ('Black Hat: assess option 2')"*), while the engine's runtime guidance tells it to emit `<task agent="Name">…</task>`. The model followed neither format for delegation and just did the work itself.
2. **Brittle parser + silent no-op.** [`parseTaskAssignments`](packages/core/src/engine/strategies/OrchestratorStrategy.ts:10) only matches `<task agent="Name">` with exact double-quotes. When nothing parses **and** there's no final answer, [`executeRound`](packages/core/src/engine/strategies/OrchestratorStrategy.ts:42) silently does `return {}` — burning a whole round with no correction, no fallback, and no loop detection.
3. **No sampling control.** The engine sets **no temperature** ([`AgentCaller`](packages/core/src/engine/strategies/AgentCaller.ts:64) never fills `ChatRequest.temperature`), so LM Studio uses its own default (~0.7) — loose enough that a weak model drifts off the required format, and nothing discourages the repetition loop.
4. **Model capability.** The local model isn't reliably following the structured protocol; sampling + prompt fixes raise the odds, but a stronger tool-capable model is still recommended.

> **Note on tool access (answers an earlier question):** worker agents **already** have full tool access — [`callAgent`](packages/core/src/engine/strategies/AgentCaller.ts:64) offers `state.tools` to every agent with no per-agent filtering. Workers didn't call tools in the failed run only because they never ran. Fixing delegation makes every hat run *with* its tools automatically; **no change is needed for that.**

---

## Workstream A — Orchestrator delegation reliability (engine)

### A1. Engine owns the delegation format (strengthen runtime guidance)

The mechanical `<task>` format is an engine implementation detail; the **engine's runtime guidance** should own it, stated explicitly and placed **last** in the system message so it wins over any preset prose. In [`buildAgentMessages`](packages/core/src/engine/strategies/AgentCaller.ts:24) the join order is `[identity, agent.systemPrompt, COLLAB_INSTRUCTIONS, extraSystem]` — `extraSystem` (the `plannerGuidance`) is already last, so strengthening it directly helps **existing** Spaces too, not just newly-created ones.

**Change** — [`OrchestratorStrategy.executeRound`](packages/core/src/engine/strategies/OrchestratorStrategy.ts:26), the `plannerGuidance` string:

```ts
const plannerGuidance =
  workers.length > 0
    ? [
        `You are the orchestrator. Available workers: ${workers.map((w) => w.name).join(', ')}.`,
        `To delegate, output one or more task blocks in EXACTLY this format, each on its own line:`,
        `<task agent="WorkerName">the specific subtask for that worker</task>`,
        `Example:`,
        `<task agent="${workers[0].name}">Gather the key facts and figures relevant to the problem.</task>`,
        `Rules:`,
        `- Prose like "WorkerName: do X" does NOT delegate — ONLY <task agent="..."> blocks trigger a worker.`,
        `- Delegate real work every turn until the problem is solved; do not just narrate.`,
        `- When the problem is fully solved, output <final_answer>...</final_answer> and nothing else.`
      ].join('\n')
    : 'You are the orchestrator. Solve the problem directly. When done, output <final_answer>...</final_answer>.';
```

### A2. Tolerant task parser

Accept single **or** double quotes and whitespace around `=`, so near-miss formatting still delegates.

**Change** — [`parseTaskAssignments`](packages/core/src/engine/strategies/OrchestratorStrategy.ts:11):

```ts
// before: /<task\s+agent="([^"]+)"\s*>([\s\S]*?)<\/task>/gi
const re = /<task\s+agent\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/task>/gi;
```

The existing test fixture (`<task agent="Researcher">`) still matches, so no regression.

### A3. No-progress + repeat guard (the core cure)

Give `OrchestratorStrategy` a tiny bit of per-run instance state (it's constructed once per run in [`RunOrchestrator.createStrategy`](packages/core/src/engine/RunOrchestrator.ts:87)) to detect a stuck orchestrator and stop wasting rounds.

A round is **"no progress"** when the orchestrator emitted **no parseable task** and **no final answer**, OR its output is a near-exact duplicate of its previous turn.

- **1st no-progress round**: inject a corrective nudge into the shared transcript and continue.
- **2nd consecutive no-progress round**: **halt** — signal the run to stop looping and go straight to the best-effort synthesis (rather than burning to `maxRounds` and risking the timeout).

**Change** — `OrchestratorStrategy`:

```ts
export class OrchestratorStrategy implements AgentStrategy {
  private noProgressStreak = 0;
  private lastOrchestratorOutput = '';

  public async executeRound(state: ExecutionState): Promise<{ finalAnswer?: string; halt?: boolean }> {
    // ... existing planning call producing planMsg ...

    const finalAnswer = extractFinalAnswer(planMsg.content);
    if (finalAnswer) return { finalAnswer };

    const tasks = parseTaskAssignments(planMsg.content);
    const isDuplicate = planMsg.content.trim() === this.lastOrchestratorOutput.trim();
    this.lastOrchestratorOutput = planMsg.content;

    if (tasks.length === 0 || isDuplicate) {
      this.noProgressStreak++;
      if (this.noProgressStreak >= 2) {
        state.onEvent({
          type: RunEventType.System,
          payload: { note: 'Orchestrator made no progress across rounds; synthesizing a best-effort answer.' }
        });
        return { halt: true };
      }
      // First offense: correct the orchestrator and give it another round.
      state.messages.push({
        role: 'user',
        content:
          'SYSTEM: You neither delegated a subtask nor gave a final answer. You MUST either delegate using ' +
          'the exact format <task agent="WorkerName">task</task>, or output <final_answer>...</final_answer>. Do one now.'
      });
      return {};
    }

    this.noProgressStreak = 0; // progress made
    // ... existing worker dispatch (Promise.all) + append WORKER results ...
    return {};
  }
}
```

**Change** — the return type in [`AgentStrategy`](packages/core/src/engine/strategies/AgentStrategy.ts:37) gains an optional `halt`:

```ts
executeRound(state: ExecutionState): Promise<{ finalAnswer?: string; halt?: boolean }>;
```

**Change** — the run loop in [`RunOrchestrator.start`](packages/core/src/engine/RunOrchestrator.ts:115) honors `halt` by breaking out to synthesis:

```ts
const result = await this.strategy.executeRound(this.state);
this.runRepo.incrementRounds(this.state.run.id);
this.state.run.roundsUsed++;
if (result.finalAnswer) { finalAnswer = result.finalAnswer; break; }
if (result.halt) break; // fall through to the best-effort synthesize() below
```

Because `finalAnswer` stays `undefined` on halt, the existing `if (finalAnswer === undefined) { … synthesize() }` block runs and the user still gets a combined answer instead of a bare failure.

### A4. De-conflict the orchestrator preset prompts (`presets.json`)

Edit the **"Output style"** line of the orchestrator agent in all **three** orchestrator-strategy presets so it no longer prescribes a prose delegation format that fights the engine's `<task>` tags. Keep the conceptual role description; drop the conflicting example.

| Preset | Orchestrator | Current conflicting fragment | Replace with |
|---|---|---|---|
| `six-thinking-hats` | Blue Hat | *"brief process directions while the session runs ('Black Hat: assess option 2')"* | *"brief delegating directions while the session runs (using the delegation format the system specifies)"* |
| `means-end-analysis` | Coordinator | *"Brief process directives (e.g., 'Goal Analyst: please define the target state.')"* | *"Brief delegating directives (using the delegation format the system specifies) and clear state summaries."* |
| `triz` | Coordinator | *"Brief directives to specific agents and summaries of progress."* | *"Brief delegating directives to specific agents (using the delegation format the system specifies) and summaries of progress."* |

> **Important caveat — existing vs. new Spaces.** Preset prompts are **copied into a Space's agents at creation time**. Editing `presets.json` only affects **newly-created** Spaces; the user's already-created Six Thinking Hats Space keeps its old prompt. **This is why A1 (engine guidance, placed last) matters most** — it repairs existing Spaces without a rebuild. To get A4's benefit on the existing Space, the user recreates it from the preset (a one-click action). This will be stated in the delivery notes.

---

## Workstream B — Sampling controls

### B1. Per-Space temperature (default **0.2**)

Low temperature makes the model pick high-probability tokens, which is exactly what structured output (delegation tags, tool calls) needs. Default **0.2**; exposed as a per-Space "Advanced" field, consistent with the existing per-Space `maxRounds`.

- **Domain** — [`Space`](packages/core/src/domain/types.ts): add `temperature?: number`.
- **Migration** — new `packages/core/src/db/migrations/004_add_temperature.sql`:
  ```sql
  ALTER TABLE spaces ADD COLUMN temperature REAL;
  ```
  Nullable; `NULL` means "use the engine default 0.2", so **existing Spaces (including the failed one) automatically get 0.2** with no data backfill.
- **Row mapping** — `rows.ts`: map the `temperature` column ↔ `Space.temperature`.
- **Repo** — `SpaceRepo.create`/`update`: persist `temperature`.
- **IPC schema** — the Zod `SpaceSchema` in `packages/desktop/src/shared/ipc.ts`: `temperature: z.number().min(0).max(2).optional()`.
- **UI** — `SpaceBuilderScreen.tsx` Advanced section: a number input (min 0, max 2, step 0.1, default 0.2) with hint *"Lower = more focused & reliable (recommended 0.2–0.4). Higher = more creative but less likely to follow instructions."* Editable even on published/preset Spaces (it's a runtime tuning knob, **not** part of the locked agent structure).

### B2. Frequency penalty (engine constant **0.3**)

The repetition loop is best addressed by a frequency penalty, **not** by raising temperature (which would hurt B1's goal). Kept as an internal engine constant — it's a reliability knob, not something users reason about.

- **Type** — [`ChatRequest`](packages/core/src/llm/types.ts:18): add `frequency_penalty?: number;` (LM Studio's OpenAI-compatible API passes it straight through, since [`chat`](packages/core/src/llm/LmStudioClient.ts:72) already spreads `...request` into the body).

### B-plumbing — thread both into every agent call

- **`ExecutionState`** ([AgentStrategy.ts](packages/core/src/engine/strategies/AgentStrategy.ts:21)): add `temperature: number;`.
- **`RunOrchestrator`** constructor: set `temperature: space.temperature ?? DEFAULT_TEMPERATURE` where `DEFAULT_TEMPERATURE = 0.2`.
- **`AgentCaller.callAgent`** ([line 64](packages/core/src/engine/strategies/AgentCaller.ts:64)) — pass both into `chat`:
  ```ts
  state.lmStudioClient.chat(
    {
      model,
      messages: working,
      tools: state.tools.length > 0 ? state.tools : undefined,
      temperature: state.temperature,
      frequency_penalty: FREQUENCY_PENALTY // = 0.3, module constant in AgentCaller
    },
    (token) => state.onToken?.(agent.id, token), // (also the streaming hook from the Phase 6 plan, if landed first)
    state.signal
  );
  ```
- **`RunOrchestrator.synthesize`** ([line 240](packages/core/src/engine/RunOrchestrator.ts:240)): pass `temperature: this.state.temperature` on its `chat` call too, for consistency.

---

## Workstream C — Timeout resilience & report availability

These address the two secondary symptoms the user reported: the hard `Model overall timeout exceeded (600000ms)` failure, and the perception that "no PDF was available."

### C1. Graceful degradation on timeout/stall (all strategies)

**Today**: any exception during the round loop — including a single generation hitting the 120 s first-token / 60 s inter-token / **600 s overall** cap in [`LmStudioClient.chat`](packages/core/src/llm/LmStudioClient.ts:66) — propagates to [`RunOrchestrator.start`](packages/core/src/engine/RunOrchestrator.ts:140)'s catch and marks the whole run **`failed`** with no answer. A 24-minute run then yields only an error.

**Fix**: when the failure is a timeout/stall **and** a usable partial transcript already exists, attempt one best-effort `synthesize()` from what was gathered and mark the run **`stopped`** (partial result) instead of `failed`. If synthesis itself fails (e.g. LM Studio is genuinely down), fall back to `failed` as today.

**Change** — `RunOrchestrator.start` catch block:

```ts
} catch (e: unknown) {
  this.abortController.abort();
  if (this.stopped) {
    this.runRepo.updateStatus(this.state.run.id, RunStatus.Stopped, Date.now());
  } else {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    const isTimeout = /timeout|stall/i.test(msg);
    const hasPartial = this.state.messages.length > 0;
    if (isTimeout && hasPartial) {
      // Salvage: the model hung, but we have material. Give the user an answer.
      try {
        const partial = await this.synthesizeSafely(); // synthesize() guarded by its own try
        if (partial) {
          this.state.onEvent({
            type: RunEventType.System,
            payload: { note: `Model timed out (${msg}); returning a best-effort answer from the partial discussion.` }
          });
          this.runRepo.completeRun(this.state.run.id, partial); // terminal + has answer + gets a PDF
          return; // skip the failed path (finally still runs: MCP cleanup, PDF)
        }
      } catch { /* fall through to failed */ }
    }
    this.runRepo.updateStatus(this.state.run.id, RunStatus.Failed, Date.now(), msg);
  }
} finally { /* unchanged: MCP close */ }
```

`synthesizeSafely()` is `synthesize()` wrapped so a second failure returns `undefined` rather than throwing (the outer abort signal is already tripped, so it uses a fresh short-lived signal for this one salvage call).

> **Interaction with A3**: A3 stops the orchestrator *reaching* the runaway state in the first place (the primary cure). C1 is the defensive net for any strategy where a *single* call still runs away — including RoundRobin/Debate, which A3 does not cover. B2's frequency penalty further reduces the odds of a runaway generation across all strategies. The 600 s overall cap itself stays — it's an intentional backstop against an infinite hang.

### C2. Make report availability unmistakable

**Finding (evidence-based)**: for the failed run, a PDF *was* generated — `pdf_path` is set in the DB and the 442 KB file is on disk. The "Open PDF" / "Show in folder" buttons **do** render for any terminal run with a `pdfPath` ([`RunScreen.tsx`](packages/desktop/src/renderer/src/screens/RunScreen.tsx:201)). So "not available" was most likely (a) the buttons sitting below the red error banner and going unnoticed, and/or (b) the PDF containing only Blue's cards (a consequence of the delegation bug, fixed by Workstream A). There is **no hard bug** in the happy path — but two robustness gaps are worth closing:

- **C2a — Surface PDF-generation failures.** Today a `writePdf` throw is swallowed by a bare `console.error` in [`RunManager`](packages/desktop/src/main/RunManager.ts:102), so a genuine failure looks identical to "no PDF." Change: on failure, still broadcast the run, and record a lightweight reason (e.g. a `System` run-event `note: 'Report generation failed: <reason>'`) so the UI can show *"Report could not be generated"* instead of silently offering nothing.
- **C2b — Label the report actions on terminal runs.** Add a small caption above the buttons (e.g. *"Report (PDF)"*) and ensure the block renders for `failed`/`stopped`/`completed` alike (it already does for `!== 'running' && pdfPath`) so a failed run's report is obviously present. Once C1 lands, most former "failed" runs become "stopped" with a real answer, so the report is clearly worth opening.

---

## Preset Workflow Validation

**Method**: validated statically against (1) the publish rules in [`validateSpaceForPublish`](packages/core/src/domain/validation.ts:9) run over the actual `presets.json` data, and (2) each strategy's coordination logic in code. Dynamic per-preset smoke tests are added as a deliverable (below).

### Structural validation — all 7 presets PASS

Ran the publish-validation rules over `presets.json`:

| Preset | Strategy | maxRounds | Agents | Orchestrators | Publishable? | Delegation-bug exposure |
|---|---|---|---|---|---|---|
| `six-thinking-hats` | orchestrator | 8 | 6 | 1 | ✅ OK | **AFFECTED** — fixed by Workstream A |
| `means-end-analysis` | orchestrator | 8 | 5 | 1 | ✅ OK | **AFFECTED** — fixed by Workstream A |
| `triz` | orchestrator | 8 | 5 | 1 | ✅ OK | **AFFECTED** — fixed by Workstream A |
| `ooda-loop` | round-robin | 3 | 4 | 0 | ✅ OK | Not affected |
| `design-thinking` | round-robin | 2 | 5 | 0 | ✅ OK | Not affected |
| `the-core-framework` | round-robin | 2 | 5 | 0 | ✅ OK | Not affected |
| `alternative-approaches` | debate | 8 | 3 | 0 | ✅ OK | Not affected |

Every preset satisfies its strategy's orchestrator-count rule (orchestrator → exactly 1; round-robin/debate → 0), has ≥1 agent, and every agent has a non-empty name/role/systemPrompt.

### Why the 4 non-orchestrator presets are structurally immune to the reported bug

The bug was specifically that the orchestrator must emit `<task>` tags to make workers run, and a weak model didn't. The other two strategies **do not delegate** — they run every agent themselves:

- **Round-robin** ([`RoundRobinStrategy`](packages/core/src/engine/strategies/RoundRobinStrategy.ts:22)): one `executeRound` is one full cycle that iterates over **every** agent in position order unconditionally. `ooda-loop`, `design-thinking`, `the-core-framework` therefore always run all their agents each cycle regardless of model behavior. A `<final_answer>` is only honored at the **end** of a cycle, so a strict pipeline (Empathize→Define→Ideate→Prototype→Test) can't be short-circuited by an early stage. Bounded work: at most `maxRounds × agents` calls (e.g. Design Thinking = 2 × 5 = 10) — no 24-minute runaway is possible.
- **Debate** ([`DebateStrategy`](packages/core/src/engine/strategies/DebateStrategy.ts:16)): each round is a concurrent propose phase + concurrent critique phase across **all** agents; converges when every critic emits `<no_objections/>`, else continues to `maxRounds` then synthesizes. `alternative-approaches` (3 agents) always runs all three in both phases.

These four are already covered by existing strategy tests (`strategies.test.ts`: round-robin "runs every agent in one executeRound…", "does not end the run when no agent declares a final answer"; debate "converges…"/"does not converge…"). They still **benefit** from Workstream B (temperature/penalty) and C1 (graceful timeout), but need **no** delegation fix.

### Dynamic validation deliverable — per-preset smoke test

Add `packages/core/src/presets/presetWorkflows.test.ts`: for **each** of the 7 presets, build its agents + strategy and run the engine against a **fake `LmStudioClient`** that emits that strategy's correct protocol signals (`<task>` for orchestrator presets, plain contributions + a late `<final_answer>` for round-robin, proposals + `<no_objections/>` for debate). Assert for each preset:
1. **Every agent produces at least one `round_start`/message event** (i.e. no agent is silently skipped) — this is the direct regression guard for the reported bug.
2. The run reaches `Completed` (or `Stopped` via the C1 salvage path) — never hangs, never `Failed` under a cooperative model.
3. Orchestrator presets: workers are dispatched via parsed `<task>` blocks; the no-progress guard halts a non-cooperative orchestrator within ≤3 rounds.

This turns "confirmed working" into an automated, permanent check for all seven workflows.

---

## Data-flow recap (for reference — no change, just documenting the contract these fixes restore)

When workers run in parallel and finish, each output lands in two places:
1. **Shared transcript** (`state.messages`) as `WORKER <name>: <content>`, appended **after** the whole parallel batch resolves, in task order (stable). This is what the orchestrator reads next round to fuse into `<final_answer>`.
2. **Persisted `run_events`** (SQLite), each tagged with `agentId` → live UI feed + PDF.

Within a single round workers don't see each other's output (they start from the same snapshot); they "meet" in the next round via the orchestrator. The orchestrator is the combiner; `synthesize()` is the safety-net combiner at max rounds / halt.

---

## Test Plan

**Core (`strategies.test.ts`)** — new/updated:
- `parseTaskAssignments` accepts single quotes, double quotes, and whitespace around `=` (add cases; keep the existing double-quote case).
- Orchestrator **no-progress guard**: an orchestrator mock that emits neither tasks nor a final answer → 1st round injects the `SYSTEM:` nudge (assert it lands in `state.messages`) and returns `{}`; 2nd consecutive → returns `{ halt: true }` and emits the "no progress" System event.
- Orchestrator **duplicate detection**: identical output twice → treated as no-progress.
- Existing "dispatches subtasks then completes on final_answer" test still passes unchanged.

**Core (`engine.test.ts`)** — new:
- **`halt` path**: a Space whose orchestrator never delegates runs to `halt` and then `synthesize()` produces a final answer; run ends `Completed` (not `Failed`, not a timeout), within a bounded number of rounds.
- **Sampling wiring**: assert the `chat` mock receives `temperature` (0.2 by default; a Space-set value when provided) and `frequency_penalty` 0.3. (Existing chat mocks ignore extra request fields, so no other engine test breaks.)

**Core (`repos.test.ts`)** — new:
- `SpaceRepo` round-trips `temperature`; a Space created without it reads back `undefined` (→ engine applies 0.2); migration `004` is idempotent on re-open.

**Desktop (`ipc.test.ts`)** — new:
- `SpaceSchema` accepts a valid `temperature` (0–2) and rejects out-of-range (`-1`, `3`).

**Presets (`spacePresets.test.ts`)** — update:
- Assert none of the three orchestrator presets' orchestrator prompts contain the old prose-delegation examples (guards against reintroducing the conflict).
- Assert every preset passes `validateSpaceForPublish` (structural regression guard for all 7).

**Presets (`presetWorkflows.test.ts`)** — new (the dynamic validation deliverable):
- For each of the 7 presets, run its strategy against a fake cooperative model and assert every agent participates and the run completes (see "Preset Workflow Validation" above).

**Timeout resilience (`engine.test.ts`)** — new:
- **C1 salvage**: a `chat` mock that throws a `timeout`-message error mid-run, with a non-empty transcript already accumulated, results in status **`stopped`** with a synthesized `finalAnswer` and a `pdfPath` — **not** `failed`.
- **C1 fallback**: a timeout with an **empty** transcript (or synthesis also throwing) still ends `failed` as before.

**Report availability (`RunManager.test.ts`)** — update:
- Existing "swallows PDF generation failures" test still passes; additionally assert that on a `writePdf` rejection a `System` note recording the failure reason is emitted (C2a), and the run still ends in its terminal state.

Full `npm run verify` (lint + typecheck + build + all tests) must pass after each workstream.

---

## Decision Log

| # | Decision | Alternative | Why |
|---|---|---|---|
| 1 | Engine's runtime guidance owns the `<task>` format; preset prompts only describe the role | Bake `<task>` syntax into every preset prompt | Keeps engine syntax out of user-editable data; and (placed last) repairs **existing** Spaces, which a preset-only edit cannot |
| 2 | Halt to synthesis after 2 consecutive no-progress rounds | Let it run to `maxRounds` | The failed run proved max-rounds looping leads to a 24-min timeout; early halt still yields a synthesized answer |
| 3 | Corrective nudge on the 1st no-progress round before halting | Halt immediately | Gives a borderline model one guided chance to comply before giving up |
| 4 | Tolerant parser (single/double quotes) | Keep strict double-quote only | Cheap robustness against the most common model formatting variance |
| 5 | Temperature **0.2** default, per-Space configurable | Global constant only / no control | User explicitly asked to set temperature; 0.2 (not 1–2) is correct for instruction-following; per-Space mirrors `maxRounds` |
| 6 | Frequency penalty **0.3** as an internal constant, not user-facing | Expose it in the UI too | It's a reliability knob users don't think in terms of; keeps the UI simple |
| 7 | Temperature editable even on published/preset Spaces | Lock it like agent structure | It's a runtime tuning knob, not structural; users need to tune it without unpublishing |
| 8 | No per-agent temperature (e.g. hotter Green Hat) in this pass | Add per-agent sampling now | YAGNI; per-Space solves the reported problem. Noted as a possible future refinement |
| 9 | On timeout/stall **with** a partial transcript, salvage → `stopped` + synthesized answer | Always hard-`fail` on timeout | A 24-min run should not yield only an error; a best-effort answer + PDF is far more useful. Falls back to `failed` if salvage fails |
| 10 | Keep the 600 s overall cap (don't raise/remove it) | Raise the cap so long generations finish | The cap is a safety backstop; the real fix is stopping runaway generation (A3 + B2), not tolerating it longer |
| 11 | Surface PDF-generation failures as a run event instead of a silent `console.error` | Leave the swallow as-is | A genuine report failure currently looks identical to "no PDF"; making it visible removes the confusion the user hit |
| 12 | Validate the other presets statically + via a new per-preset smoke test | Manual end-to-end runs only | Deterministic, automated, permanent regression coverage for all 7 workflows; end-to-end needs LM Studio and is non-repeatable |

## Assumptions

1. LM Studio honors `temperature` and `frequency_penalty` via its OpenAI-compatible `/chat/completions` (standard; already how `stream`, `tools` are passed).
2. A `NULL` temperature column reads back as `undefined` and the engine substitutes 0.2 — so no data migration/backfill is needed for existing Spaces.
3. These changes are independent of the Phase 6 UI-polish plan; if token streaming lands first, the `onToken` hook in the `callAgent` snippet is already present — otherwise it stays the current no-op. Neither blocks the other.

## Implementation Order

1. **B (sampling)** first — smallest, immediately improves every run *and every preset* (better odds the model complies), and is a prerequisite the delegation fixes lean on.
2. **A1 + A2** (guidance + parser) — make delegation actually fire.
3. **A3** (no-progress/halt guard) — the safety net that stops the orchestrator ever reaching a 24-minute timeout.
4. **C1** (graceful timeout salvage) — defensive net for any strategy; turns hung runs into partial answers + a useful PDF.
5. **C2** (report-availability robustness) — surface PDF failures, label the report actions.
6. **A4** (preset de-conflict) — polish for newly-created Spaces.
7. **Preset validation** (`presetWorkflows.test.ts` + `spacePresets.test.ts` additions) — lock in "all 7 workflows confirmed working."

Each step: `npm run verify`, then relaunch the app so the user can manually re-run the exact "Six Thinking Hats / population" scenario and confirm all six hats now participate.

## Acceptance Criteria

- Re-running the failed scenario: **all six hats run** (worker `round_start` events for White/Red/Black/Yellow/Green appear), the run reaches a terminal state **without** hitting the 600 s overall cap, and produces a final answer + a PDF containing every hat's cards.
- An orchestrator that refuses to delegate is caught by the no-progress guard and **halts to synthesis within a few rounds**, never looping to a timeout.
- A model that hangs on a single call **with** prior discussion yields a **`stopped`** run carrying a best-effort answer and a PDF — not a bare `failed`.
- A genuine report-generation failure is **visible** in the UI (a "report could not be generated" note), not silent.
- Every agent `chat` request carries `temperature` (0.2 default, or the Space's value) and `frequency_penalty` 0.3.
- A Space's temperature is settable in the builder's Advanced section (0–2), persists, and is used at run time.
- **All 7 presets**: pass structural validation, and the per-preset smoke test confirms every agent participates and each run completes.
- `npm run verify` green after each workstream.
