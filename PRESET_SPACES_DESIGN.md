# Prebuilt (Preset) Spaces — Design

**Status**: Validated design (brainstorming complete)
**Companion to**: [DESIGN.md](DESIGN.md), [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)

## Understanding Summary

- **What**: A curated gallery of 7 prebuilt Space presets (Six Thinking Hats, OODA Loop, Means-End Analysis, Design Thinking, TRIZ, Alternative Approaches, The Core Framework). Picking one creates a fully pre-configured **draft** Space (correct strategy + full agent lineup) in one click, landing in the existing Space Builder to review/tune before publishing.
- **Why**: Building any of these multi-agent methodologies by hand takes ~10+ manual steps. A preset collapses that to one click while still requiring the user to review, add MCP servers, pick a model, and explicitly publish.
- **Entry point**: "New Space" offers a choice — "Start from scratch" (unchanged) or "Start from a prebuilt Space" (the gallery).
- **Key constraint**: preset Spaces are **structure-locked** — only default model, max rounds, allowed MCP servers, and each agent's model/system prompt are editable. Name, description, strategy, agent name/role/orchestrator-flag, and adding/removing agents are locked. The whole Space can still be deleted.
- **Key constraint**: **one Space per preset, max**. If a preset already has a Space, the gallery shows "Open" (jumps to it) instead of "Create."
- **Non-goals**: no in-app preset-authoring UI; no auto-selected model/MCP; no auto-publish; not a third-party plugin system.

## Assumptions

1. Preset agent prompts live inline in the preset catalog (not the shared `roles.json` role-template list) — keeps the general template picker from ballooning with preset-only names; reuse doesn't matter since they're locked anyway.
2. Per-preset `maxRounds` default (~8), adjustable before publish.
3. Backend enforcement is the actual source of truth; UI disabling is a courtesy (consistent with the `hasActiveRun` pattern already used elsewhere).
4. A Space's `presetId` is set at creation and never changes.

## Decision Log

| # | Decision | Alternative considered | Why |
|---|---|---|---|
| 1 | Preset creates a **draft** Space, reviewed before publishing | Auto-publish immediately | Matches how hand-built Spaces work; user still picks MCP/model |
| 2 | Entry point: choice inside "New Space" | Separate top-level gallery tab | One entry point for "make a Space" |
| 3 | OODA / Design Thinking / The Core Framework → **Round-robin** | Orchestrator | Fundamentally ordered methods; fixed turn order enforces sequence natively |
| 4 | Means-End Analysis / TRIZ → **Orchestrator** | Round-robin | Iterative/delegated by nature, matching Orchestrator's existing loop |
| 5 | Alternative Approaches → **Debate** | Orchestrator | Directly matches propose/critique/converge |
| 6 | Preset prompts inline in the preset catalog | Add to `roles.json` | Avoids bloating the general template picker with locked, preset-only names |
| 7 | Preset Spaces are **structure-locked** (model/rounds/MCP/agent-model/agent-prompt only) | Fully editable | Preserves each method's integrity while allowing real tuning |
| 8 | **One Space per preset**, enforced server-side | Allow duplicates | Prevents confusing identical-looking Spaces |
| 9 | Existing preset → gallery shows **Open** | Disabled card / error on create | No dead ends, clearest UX |
| 10 | Preset Space can still be **deleted** entirely | Permanent/undeletable | Avoids junk accumulating with no cleanup path |

## The 7 Presets

| Preset id | Strategy | Agents |
|---|---|---|
| `six-thinking-hats` | Orchestrator | Blue Hat (orchestrator) + White, Red, Black, Yellow, Green Hat |
| `ooda-loop` | Round-robin | Observer → Orienter → Decider → Actor |
| `means-end-analysis` | Orchestrator | Means-End Coordinator (orchestrator) + Goal Analyst, Current-State Analyst, Operator Selector, Progress Evaluator |
| `design-thinking` | Round-robin | Empathizer → Definer → Ideator → Prototyper → Tester |
| `triz` | Orchestrator | TRIZ Coordinator (orchestrator) + Contradiction Analyst, Abstraction Specialist, Inventive-Principles Expert, Solution Synthesizer |
| `alternative-approaches` | Debate | 3 strategists proposing distinct approaches, then critiquing/comparing to converge |
| `the-core-framework` | Round-robin | Problem Definer → Deconstructor → Constraints & Resources Analyst → Hypothesis Tester → Evaluator/Scaler |

## Design

### 1. Data model

- **New Space field**: `presetId: string | null`. `null` = hand-built; non-null = which preset it came from. Requires a new nullable column + migration.
- **New preset catalog** (`core/src/presets/presets.json`, bundled like `roles.json`): one entry per preset — id, name, description, strategy, maxRounds, and a full agent list (name, role, systemPrompt, isOrchestrator) with prompts written inline.
- **New atomic operation**: "create Space from preset" — the *only* path allowed to build a preset Space; creates the Space row + all agent rows in one transaction.

### 2. Backend enforcement (the actual gate)

- **One-per-preset**: before creating, check no existing Space has that `presetId`; refuse if one exists (belt-and-suspenders — the UI already prevents reaching this path via the gallery's Open/Create split).
- **Agent add/delete blocked** entirely when the parent Space has a `presetId`.
- **Agent update**: on a preset Space, only `modelId` and `systemPrompt` may change; any attempt to change name/role/position/orchestrator-flag rejects the *whole* update (no partial success).
- **Space update**: on a preset Space, only `defaultModel`, `maxRounds`, `allowedMcpServerIds` may change; attempts to change name/description/strategy are rejected.
- **Delete** (Space) is unaffected by the preset lock — still works, still subject to the existing "no active run" guard.

### 3. IPC layer

- **New**: list presets (returns catalog entries + whether each already has a Space, and that Space's id if so).
- **New**: create Space from preset (takes a preset id, returns the new Space).
- **Existing** Space/Agent update operations gain the Part 2 checks; shape unchanged, just sometimes refuse with a clear reason.

### 4. UI

- **"New Space"** opens a choice: *Start from scratch* / *Start from a prebuilt Space*.
- **Gallery**: 7 cards (name, description, strategy/agent-count). Button is **Create**, or **Open** (visually distinct) if that preset already has a Space.
- **Builder, on a preset Space**: name/description/strategy shown but disabled; no Add-agent button; no per-agent Delete/reorder; agent editor shows only model + system prompt as editable, name/role/orchestrator-flag shown disabled. Publish/Unpublish/Delete unaffected.

### 5. Testing

- Backend: preset creation builds correctly; duplicate creation refused; agent add/delete refused on preset Spaces; agent update allows model/prompt, refuses name/role/orchestrator (including bundled attempts); Space update allows model/rounds/MCP, refuses name/description/strategy; delete still works including under the active-run guard.
- IPC: preset list correctly reports existing-Space linkage.
- No new automated UI tests (consistent with the rest of the project — manual testing is the acceptance path for screens).
