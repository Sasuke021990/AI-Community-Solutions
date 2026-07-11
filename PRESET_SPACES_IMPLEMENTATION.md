# Prebuilt (Preset) Spaces — Implementation Guide

**Companion to**: [PRESET_SPACES_DESIGN.md](PRESET_SPACES_DESIGN.md) (validated design — read that first for the *why*; this doc is the *how*, file by file)

This guide is precise about **what to build**: exact schema, exact locked-field logic, exact new/changed method signatures, exact IPC contract, exact UI behavior, and the complete structural metadata (id/name/strategy/agent roster) for all 7 presets. Agent **system prompt prose** is specified as a content brief per agent (what it must instruct), not pre-written in full here — the actual ~150–200 word prompts get written at implementation time following the same structure as the existing Six Hats rewrite (role definition → responsibilities → method → collaboration behavior → output style), so the prose isn't duplicated between planning and implementation.

Work proceeds in 4 tranches, each independently verifiable (`npm run verify`) and committed separately, same pattern as the rest of this session.

---

## Tranche 1 — Data model (core package)

### 1.1 Migration `002_add_preset_support.sql`

New file: `packages/core/src/db/migrations/002_add_preset_support.sql`

```sql
ALTER TABLE spaces ADD COLUMN preset_id TEXT;
CREATE INDEX IF NOT EXISTS idx_spaces_preset_id ON spaces(preset_id);
```

SQLite supports `ADD COLUMN` in place (no table rebuild needed) since the column is nullable with no default. The existing migration runner (`Database.ts`) picks this up automatically — it globs `*.sql` in the migrations dir in filename order and tracks applied versions in `schema_migrations`.

### 1.2 `packages/core/src/db/rows.ts`

Add `preset_id: string | null` to `SpaceRow`.

### 1.3 `packages/core/src/domain/types.ts`

Add to `Space`:
```ts
presetId?: string | null;
```
Optional so every existing test/call-site constructing a plain `Space` object without this field keeps compiling; `mapRowToSpace` always populates it from the DB (never leaves it `undefined` on a read).

### 1.4 New preset catalog module

New file: `packages/core/src/presets/spacePresets.ts`
```ts
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Strategy } from '../domain/enums.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface SpacePresetAgent {
  name: string;
  role: string;
  systemPrompt: string;
  isOrchestrator: boolean;
}

export interface SpacePreset {
  id: string;
  name: string;
  description: string;
  strategy: Strategy;
  maxRounds: number;
  agents: SpacePresetAgent[];
}

let cache: SpacePreset[] | null = null;

/**
 * Static catalog of prebuilt Space presets, bundled with the package (same
 * pattern as role templates - see Decision #20 and the preset design's
 * Decision #6). Agent prompts are written inline here, not pulled from the
 * general role-template list, since preset agents are structure-locked and
 * reuse doesn't matter.
 */
export function listSpacePresets(): SpacePreset[] {
  if (!cache) {
    const raw = readFileSync(join(__dirname, 'presets.json'), 'utf-8');
    cache = JSON.parse(raw) as SpacePreset[];
  }
  return cache;
}
```

New file: `packages/core/src/presets/presets.json` — full content specified in **Section 5** below.

### 1.5 `packages/core/src/index.ts`

Add:
```ts
// Space presets
export * from './presets/spacePresets.js';
```

### 1.6 `packages/core/scripts/copy-assets.mjs`

Add a third copy function mirroring `copyRoleTemplates()`:
```ts
function copyPresets() {
  const src = join(here, '..', 'src', 'presets', 'presets.json');
  const destDir = join(here, '..', 'dist', 'presets');
  const dest = join(destDir, 'presets.json');
  if (!existsSync(src)) {
    console.error(`[copy-assets] presets source not found: ${src}`);
    process.exit(1);
  }
  mkdirSync(destDir, { recursive: true });
  copyFileSync(src, dest);
  console.log('[copy-assets] copied presets.json into dist/presets');
}
```
Call it alongside the existing two calls at the bottom of the file: `copyMigrations(); copyRoleTemplates(); copyPresets();`

### Tranche 1 tests (`packages/core/src/presets/spacePresets.test.ts`, new file)

- `listSpacePresets()` returns exactly 7 entries, unique ids.
- Every preset's `agents` array matches the roster in Section 5 (name + role + isOrchestrator count).
- Orchestrator-strategy presets have exactly one `isOrchestrator: true` agent; round-robin/debate presets have zero.
- Every agent's `systemPrompt.length > 200` (professional-grade, not a stub) and contains no `{{...}}` placeholders (same invariant as role templates).

---

## Tranche 2 — Backend enforcement (repos)

### 2.1 `packages/core/src/db/repos/AgentRepo.ts`

Replace `assertSpaceDraft` with a combined lock lookup used by all three mutating methods:

```ts
private getSpaceLock(spaceId: string): { published: boolean; presetId: string | null } {
  const space = this.db
    .prepare('SELECT status, preset_id FROM spaces WHERE id = ?')
    .get(spaceId) as { status: string; preset_id: string | null } | undefined;
  return { published: space?.status === 'published', presetId: space?.preset_id ?? null };
}
```

**`create(agent)`**:
```ts
public create(agent: Agent): void {
  const lock = this.getSpaceLock(agent.spaceId);
  if (lock.published) throw new Error('Cannot modify agents when Space is published.');
  if (lock.presetId) throw new Error("This Space's agent lineup is fixed by its preset and cannot be changed.");
  // ...existing INSERT unchanged...
}
```

**`delete(id, spaceId)`**: same two checks before the `DELETE`.

**`update(agent)`**: published check unchanged; preset check compares the incoming object against the *currently stored* row (not the caller's belief of what changed) — this is what makes the lock airtight even if the UI has a bug:
```ts
public update(agent: Agent): void {
  const lock = this.getSpaceLock(agent.spaceId);
  if (lock.published) throw new Error('Cannot modify agents when Space is published.');
  if (lock.presetId) {
    const current = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(agent.id) as AgentRow | undefined;
    if (!current) throw new Error('Agent not found');
    if (
      agent.name !== current.name ||
      agent.role !== current.role ||
      agent.isOrchestrator !== (current.is_orchestrator === 1) ||
      agent.position !== current.position
    ) {
      throw new Error(
        "This agent's name, role, position, and orchestrator status are fixed by the Space's preset " +
        "- only its model and system prompt can be changed."
      );
    }
  }
  // ...existing UPDATE unchanged...
}
```
Rejects the **whole** update if any locked field differs — no partial success, even if a valid model/prompt change was bundled with an invalid name change.

### 2.2 `packages/core/src/db/repos/SpaceRepo.ts`

**`update(space)`**: fetch the full current row (not just `status`, as today) and add the preset check:
```ts
public update(space: Space): void {
  const current = this.db.prepare('SELECT * FROM spaces WHERE id = ?').get(space.id) as SpaceRow | undefined;
  if (!current) throw new Error('Space not found');
  if (current.status === SpaceStatus.Published) {
    throw new Error('Cannot edit a published space. Unpublish it first.');
  }
  if (current.preset_id) {
    if (
      space.name !== current.name ||
      space.description !== current.description ||
      space.strategy !== current.strategy
    ) {
      throw new Error("This Space's name, description, and strategy are fixed by its preset and cannot be changed.");
    }
  }
  // ...existing transaction/UPDATE unchanged (still writes name/description/
  // strategy - safe no-op since we just verified they're unchanged when locked)...
}
```

**`create(space)`**: include the new column in the INSERT — `preset_id` = `space.presetId ?? null`. (This is the plain hand-built-Space path; it always inserts `NULL` in practice, since only `createFromPreset` ever populates `presetId`.)

**`mapRowToSpace(row)`**: add `presetId: row.preset_id` to the returned object.

**New method — `createFromPreset(space, agents)`**, the *only* path allowed to build a preset Space's agents:
```ts
public createFromPreset(space: Space, agents: Agent[]): Space {
  if (!space.presetId) throw new Error('createFromPreset requires a presetId');

  const existing = this.db.prepare('SELECT id FROM spaces WHERE preset_id = ?').get(space.presetId);
  if (existing) throw new Error(`A Space for this preset already exists.`);

  return this.db.transaction(() => {
    // Insert with preset_id NULL first - AgentRepo.create()'s guard only
    // blocks published Spaces and preset-locked Spaces; inserting agents
    // BEFORE locking the preset_id in means this transaction is the only
    // window where agents can be added, with zero special-casing needed
    // in AgentRepo itself.
    this.db.prepare(`
      INSERT INTO spaces (id, name, description, strategy, default_model, max_rounds, status, preset_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      space.id, space.name, space.description, space.strategy, space.defaultModel,
      space.maxRounds, space.status, space.createdAt, space.updatedAt
    );

    for (const agent of agents) {
      this.agentRepo.create(agent);
    }

    this.db.prepare('UPDATE spaces SET preset_id = ? WHERE id = ?').run(space.presetId, space.id);

    return this.get(space.id)!;
  })();
}
```

**`delete()`, `unpublish()`, `publish()`**: **no changes**. Per the design, deletion and unpublish/publish are unaffected by the preset lock — only structural agent/field edits are blocked. `assertNoActiveRun` (already there) is the only guard on delete/unpublish, unchanged.

### Tranche 2 tests (append to `packages/core/src/db/repos.test.ts`)

- `createFromPreset` builds the Space + all agents correctly, `presetId` set, agents have correct `position` (0-indexed, in array order).
- `createFromPreset` called twice with the same preset id throws (`already exists`) — second call makes **no** partial writes (verify agent count unchanged).
- On a preset Space: `agentRepo.create()` throws; `agentRepo.delete()` throws; `agentRepo.update()` with only `modelId`/`systemPrompt` changed succeeds; `agentRepo.update()` with `name` changed throws (even when bundled with a valid `systemPrompt` change) and the prompt is **not** partially saved.
- On a preset Space: `spaceRepo.update()` with only `defaultModel`/`maxRounds`/`allowedMcpServerIds` changed succeeds; with `name` or `strategy` changed throws.
- On a preset Space: `spaceRepo.delete()` still succeeds (and still respects the existing active-run guard); `spaceRepo.unpublish()`/`publish()` unaffected by the lock.

---

## Tranche 3 — IPC layer

### 3.1 `packages/desktop/src/shared/ipc.ts`

New schema:
```ts
export const SpaceCreateFromPresetSchema = z.object({ presetId: z.string().min(1) });
```

Two new channel entries in the `Channels` registry:
```ts
presetsList: defineChannel('presets:list', EmptySchema),
spacesCreateFromPreset: defineChannel('spaces:createFromPreset', SpaceCreateFromPresetSchema),
```
No changes needed to `SpaceInputSchema`/`SpaceUpdateSchema`/`AgentInputSchema`/`AgentUpdateSchema` — the lock is enforced by comparing against the *stored* row inside the repo (Tranche 2), not by the request shape.

### 3.2 `packages/desktop/src/main/ipcRouter.ts`

Import `listSpacePresets` alongside the existing `listRoleTemplates` import.

New response type, next to the existing `SpaceWithActivity`:
```ts
export type PresetWithStatus = SpacePreset & { existingSpaceId: string | null };
```

Two new handlers:
```ts
[Channels.presetsList.name]: async () => {
  const presets = listSpacePresets();
  const spaces = repos.spaces.list();
  return presets.map((p): PresetWithStatus => ({
    ...p,
    existingSpaceId: spaces.find((s) => s.presetId === p.id)?.id ?? null
  }));
},

[Channels.spacesCreateFromPreset.name]: async (p) => {
  const { presetId } = Channels.spacesCreateFromPreset.requestSchema.parse(p);
  const preset = listSpacePresets().find((pr) => pr.id === presetId);
  if (!preset) throw new Error(`Unknown preset "${presetId}"`);

  const now = Date.now();
  const spaceId = randomUUID();
  const space = {
    id: spaceId,
    name: preset.name,
    description: preset.description,
    strategy: preset.strategy,
    defaultModel: '',
    maxRounds: preset.maxRounds,
    status: SpaceStatus.Draft,
    presetId: preset.id,
    createdAt: now,
    updatedAt: now
  };
  const agents = preset.agents.map((a, i) => ({
    id: randomUUID(),
    spaceId,
    name: a.name,
    role: a.role,
    systemPrompt: a.systemPrompt,
    isOrchestrator: a.isOrchestrator,
    position: i
  }));

  const created = repos.spaces.createFromPreset(space, agents);
  return withActivity(created);
}
```
(`withActivity` is the existing helper already used by `spacesList`/`spacesGet`/`spacesCreate`.)

### 3.3 `packages/desktop/src/preload/index.ts`

Add `SpacePreset`/`SpacePresetAgent` to the `@acs/core` type import list, and `PresetWithStatus` to the `../main/ipcRouter.js` type import (alongside the existing `SpaceWithActivity` import — add the same `export type { PresetWithStatus }` re-export line so the renderer can reach it the same way it reaches `SpaceWithActivity`).

New `presets` section on the `api` object (replacing the current `templates` section's neighbor, additive):
```ts
presets: {
  list: () => invoke<PresetWithStatus[]>(Channels.presetsList.name),
  create: (presetId: string) => invoke<SpaceWithActivity>(Channels.spacesCreateFromPreset.name, { presetId })
},
```

### Tranche 3 tests (append to `packages/desktop/src/main/ipcRouter.test.ts`)

- `presets:list` returns 7 entries; for a preset with no Space yet, `existingSpaceId` is `null`; after creating one via `spaces:createFromPreset`, re-listing shows that preset's `existingSpaceId` pointing at the new Space's id.
- `spaces:createFromPreset` with an unknown id returns an error envelope.
- `spaces:createFromPreset` called twice for the same preset: second call returns an error envelope (surfacing the repo's "already exists" error), first call's Space is untouched.
- The created Space's agents (`agents:listBySpace`) match the preset's roster exactly (count, names, orchestrator flag, position order).

---

## Tranche 4 — UI

### 4.1 `packages/desktop/src/renderer/src/view.ts`

Add a new view variant:
```ts
| { name: 'gallery' }
```
`topLevelFor` unchanged (gallery still highlights "Spaces" in the sidebar — same as `'builder'`/`'run'`/`'history'` do today, since none of those are listed explicitly and the function falls through to `return 'spaces'`).

### 4.2 New screen: `packages/desktop/src/renderer/src/screens/PresetGalleryScreen.tsx`

```tsx
import { useEffect, useState } from 'react';
import type { PresetWithStatus } from '../../../preload/index.js';
import { call } from '../lib/api.js';

interface PresetGalleryScreenProps {
  onCreated: (spaceId: string) => void;
  onOpenExisting: (spaceId: string) => void;
  onBack: () => void;
}

export function PresetGalleryScreen({ onCreated, onOpenExisting, onBack }: PresetGalleryScreenProps) {
  const [presets, setPresets] = useState<PresetWithStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creatingId, setCreatingId] = useState<string | null>(null);

  useEffect(() => {
    call(window.acs.presets.list())
      .then(setPresets)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function create(presetId: string) {
    setCreatingId(presetId);
    setError(null);
    try {
      const space = await call(window.acs.presets.create(presetId));
      onCreated(space.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreatingId(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <button className="btn-link" onClick={onBack} style={{ paddingLeft: 0 }}>
            &larr; Spaces
          </button>
          <h1>Start from a prebuilt Space</h1>
          <p className="subtitle">
            A ready-made team for a known methodology. You can still tune the model, rounds, MCP
            servers, and each agent's prompt before publishing.
          </p>
        </div>
      </div>

      {error && <div className="banner banner-error">{error}</div>}

      {loading ? (
        <div className="empty-state">Loading...</div>
      ) : (
        <div className="card-grid">
          {presets.map((p) => (
            <div key={p.id} className="card">
              <strong>{p.name}</strong>
              <div style={{ color: 'var(--text-dim)', fontSize: 12, margin: '6px 0 10px' }}>{p.description}</div>
              <div className="field-hint" style={{ marginBottom: 10 }}>
                {p.strategy} · {p.agents.length} agent(s)
              </div>
              {p.existingSpaceId ? (
                <button className="btn" style={{ width: '100%' }} onClick={() => onOpenExisting(p.existingSpaceId!)}>
                  Open
                </button>
              ) : (
                <button
                  className="btn btn-primary"
                  style={{ width: '100%' }}
                  onClick={() => create(p.id)}
                  disabled={creatingId === p.id}
                >
                  {creatingId === p.id ? 'Creating...' : 'Create'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```
`Open` uses `visual distinction` per the design (different button class, `btn` not `btn-primary`) so it reads differently from `Create` at a glance.

### 4.3 `packages/desktop/src/renderer/src/screens/SpacesHomeScreen.tsx`

The single "New Space" button becomes two buttons side by side (simplest way to offer the choice without a dropdown/modal — matches the project's existing pattern of plain button rows rather than menus):
```tsx
<div className="row">
  <button className="btn" onClick={onOpenGallery}>
    Start from a prebuilt Space
  </button>
  <button className="btn btn-primary" onClick={() => onOpenBuilder(null)}>
    New Space
  </button>
</div>
```
New prop `onOpenGallery: () => void` added to `SpacesHomeScreenProps`.

### 4.4 `packages/desktop/src/renderer/src/App.tsx`

- Import `PresetGalleryScreen`.
- Add `'gallery'` case:
  ```tsx
  case 'gallery':
    content = (
      <PresetGalleryScreen
        onCreated={(id) => setView({ name: 'builder', spaceId: id })}
        onOpenExisting={(id) => setView({ name: 'builder', spaceId: id })}
        onBack={() => setView({ name: 'spaces' })}
      />
    );
    break;
  ```
- Pass `onOpenGallery={() => setView({ name: 'gallery' })}` into the existing `SpacesHomeScreen` usage.

### 4.5 `packages/desktop/src/renderer/src/screens/SpaceBuilderScreen.tsx`

New derived constant alongside the existing `isPublished`:
```ts
const isPreset = !!space?.presetId;
```

**Space-level locked fields** — `disabled={isPublished}` becomes `disabled={isPublished || isPreset}` on exactly three inputs: **Name**, **Description**, **Coordination strategy**. The other three (**Default model**, **Max rounds**, **Allowed MCP servers** checkboxes) keep `disabled={isPublished}` unchanged — still editable on a preset Space, per the design.

**Collapsed-summary toggle**: unaffected — a preset Space still gets the same collapse/expand behavior as any draft Space; "Edit details" still works (it reveals the form so the user can see/change the still-editable model/rounds fields), the three locked fields just render disabled within it.

**Agent list — no Add, no Delete, no reorder** when `isPreset`:
```tsx
{!isPublished && !isPreset && (
  <div className="row">
    <button className="btn-link" onClick={() => moveAgent(agent, -1)} disabled={i === 0}>↑</button>
    <button className="btn-link" onClick={() => moveAgent(agent, 1)} disabled={i === sortedAgents.length - 1}>↓</button>
    <button className="btn-link" onClick={() => setEditingAgent(agent)}>Edit</button>
    <button className="btn-link" onClick={() => deleteAgent(agent)}>Delete</button>
  </div>
)}
{!isPublished && isPreset && (
  <div className="row">
    <button className="btn-link" onClick={() => setEditingAgent(agent)}>Edit</button>
  </div>
)}
```
(Edit stays available even when preset-locked — that's how the user reaches the still-editable model/prompt fields.)

**"Add agent" button**: only rendered when `!isPublished && !isPreset`:
```tsx
{!isPublished && !isPreset && editingAgent === null && (
  <div className="row">
    <button className="btn" onClick={() => setEditingAgent('new')}>Add agent</button>
    <button className="btn btn-primary" onClick={() => setConfirmPublish(true)}>Publish</button>
  </div>
)}
{!isPublished && isPreset && editingAgent === null && (
  <div className="row">
    <button className="btn btn-primary" onClick={() => setConfirmPublish(true)}>Publish</button>
  </div>
)}
```

**Pass `structureLocked={isPreset}`** into both `<AgentEditor>` usages (the existing-agent one and the `'new'` one — though in practice `'new'` never renders when `isPreset`, since "Add agent" is hidden; the prop is passed for type-safety/consistency regardless).

### 4.6 `packages/desktop/src/renderer/src/components/AgentEditor.tsx`

New prop:
```ts
structureLocked?: boolean;
```

When `structureLocked` is true:
- **Name** input: `disabled`.
- **Role template** `<select>`: `disabled` (no point picking a different template — role is fixed).
- **Role title** input: `disabled`.
- **Orchestrator checkbox**: `disabled`.
- **`showAdvanced` defaults to `true`** when `structureLocked` (via `useState(structureLocked ?? false)`), since the system prompt and model override — the *only* editable fields — live behind that toggle; forcing an extra click to reach the one thing you're allowed to change would be poor UX.
- **System prompt** textarea and **Model override** `<select>`: unaffected, stay fully editable.
- The `save()` function's payload already sends `name`/`role`/`isOrchestrator`/`position` unchanged (since those inputs are disabled, React state never diverges from `existingAgent`'s original values) — so no changes needed there; the backend lock (Tranche 2) is what actually protects against any drift, this is just the UI staying honest with what it displays.

### Tranche 4 verification

No new automated UI tests (consistent with the rest of the project). Manual pass: open the gallery, create each of the 7 presets once, confirm each publishes cleanly (agent/orchestrator counts satisfy `validateSpaceForPublish`), confirm the gallery immediately shows "Open" for each after creation, confirm a second gallery visit doesn't allow re-creating any of them, confirm locked fields are genuinely un-editable (attempt via Advanced still finds them disabled) and editable fields (model, rounds, MCP, agent model/prompt) genuinely save.

---

## Section 5 — Complete preset roster (all 7)

For each preset: id, name, one-line description, strategy, default `maxRounds`, and the exact agent list (name, role, orchestrator flag, in position order). The **content brief** after each agent name is what that agent's `systemPrompt` must instruct — written out in full prose at implementation time in `presets.json`, following the same structure as the existing role templates (role definition → responsibilities → method → collaboration behavior → output style; ~150–200 words).

### `six-thinking-hats` *(already exists as role templates — this preset just assembles them)*
Strategy: `orchestrator` · maxRounds: 8
1. **Blue** — role "Blue Hat" — *(orchestrator)* — process manager/synthesizer (existing Blue Hat template prose)
2. **White** — "White Hat" — facts/data only (existing)
3. **Red** — "Red Hat" — gut feeling only (existing)
4. **Black** — "Black Hat" — risk/caution (existing)
5. **Yellow** — "Yellow Hat" — optimism/value (existing)
6. **Green** — "Green Hat" — creativity/alternatives (existing)

*(These six prompts already exist verbatim in `roles.json` from last session — copy them into this preset entry rather than rewriting.)*

### `ooda-loop`
Strategy: `round-robin` · maxRounds: 8
1. **Observer** — role "Observer" — gathers raw, unfiltered observations about the current situation; explicitly separates observed fact from interpretation; flags what's still unknown.
2. **Orienter** — role "Orienter" — synthesizes the Observer's data through relevant experience/context/mental models; identifies what the situation actually *means* and what's changed since the last cycle.
3. **Decider** — role "Decider" — commits to one specific course of action given the Orientation, stating the decision plainly and the key reason for it over the alternatives.
4. **Actor** — role "Actor" — states concretely what executing the Decider's choice looks like, what to watch for as feedback, and whether the loop should close (final answer) or cycle again given what's now known.

### `means-end-analysis`
Strategy: `orchestrator` · maxRounds: 8
1. **Coordinator** — role "Means-End Coordinator" — *(orchestrator)* — each round: state the current biggest difference between current state and goal state, delegate closing it to the right specialist, and decide whether the gap is closed (final answer) or another round is needed.
2. **Goal Analyst** — role "Goal Analyst" — defines and clarifies precisely what the goal state is, surfacing any ambiguity in what "done" means.
3. **Current-State Analyst** — role "Current-State Analyst" — establishes precisely what the current state actually is, grounded in fact (same discipline as the Researcher/White Hat role).
4. **Operator Selector** — role "Operator Selector" — proposes the specific action/operator that reduces the current gap, including its preconditions and expected effect.
5. **Progress Evaluator** — role "Progress Evaluator" — checks whether applying the proposed operator actually reduced the gap, and by how much.

### `design-thinking`
Strategy: `round-robin` · maxRounds: 10
1. **Empathizer** — role "Empathizer" — articulates the real human need/pain point behind the problem, from the affected user's perspective, not the solver's.
2. **Definer** — role "Definer" — converts the Empathizer's findings into one sharp, actionable problem statement ("How might we...").
3. **Ideator** — role "Ideator" — generates multiple distinct concepts addressing the Definer's problem statement, quantity and variety over immediate feasibility (same lateral-thinking discipline as the Green Hat).
4. **Prototyper** — role "Prototyper" — picks the strongest idea(s) and describes concretely what a minimal testable version looks like.
5. **Tester** — role "Tester" — evaluates the Prototyper's concept against the original need, states what worked/didn't, and whether to iterate (another cycle) or the concept is validated (final answer).

### `triz`
Strategy: `orchestrator` · maxRounds: 8
1. **Coordinator** — role "TRIZ Coordinator" — *(orchestrator)* — drives the TRIZ cycle: identify the core contradiction, delegate abstraction and principle-matching, then delegate re-specialization into a concrete solution.
2. **Contradiction Analyst** — role "Contradiction Analyst" — identifies the core technical/physical contradiction in the problem (improving X worsens Y) precisely.
3. **Abstraction Specialist** — role "Abstraction Specialist" — restates the concrete contradiction as TRIZ's general/abstract contradiction pattern, stripped of domain specifics.
4. **Inventive-Principles Expert** — role "Inventive-Principles Expert" — applies relevant TRIZ inventive principles (segmentation, asymmetry, prior counteraction, etc.) to the abstracted contradiction, explaining why each fits.
5. **Solution Synthesizer** — role "Solution Synthesizer" — translates the abstract inventive principle(s) back into a concrete, specific solution for the original domain problem.

### `alternative-approaches`
Strategy: `debate` · maxRounds: 8
1. **Strategist A** — role "Strategist" — proposes a genuinely distinct solution approach (not a variation of another agent's), with its core rationale.
2. **Strategist B** — role "Strategist" — proposes a second, meaningfully different approach from Strategist A's, with its core rationale.
3. **Strategist C** — role "Strategist" — proposes a third, meaningfully different approach from both A and B, with its core rationale.

*(All three share the same base role prompt — "propose a genuinely different approach, then in critique rounds attack the other proposals' weak points and defend or revise your own" — matching the existing `DebateStrategy`'s propose/critique/converge shape; agent **names** differ so the transcript stays readable, but instructions are identical since Debate doesn't assign differentiated lenses the way Six Hats does.)*

### `the-core-framework`
*(Your own 5-step method, mapped directly — content briefs quote your original wording where it's already precise.)*
Strategy: `round-robin` · maxRounds: 8
1. **Problem Definer** — role "Problem Definer" — isolates the root problem from its side effects/symptoms and states it in one clear sentence.
2. **Deconstructor** — role "Deconstructor" — breaks the root problem into isolated, modular, manageable sub-problems and identifies which one is the actual bottleneck blocking the rest.
3. **Constraints & Resources Analyst** — role "Constraints & Resources Analyst" — assesses hard limits (budget/time/technical) and takes inventory of available tools/knowledge/team to leverage.
4. **Hypothesis Tester** — role "Hypothesis Tester" — proposes a straightforward, logical fix based on available data, and describes a small, controlled, logged test of it.
5. **Evaluator/Scaler** — role "Evaluator/Scaler" — judges the test: if it failed, states why and what variable to adjust next; if it succeeded, states how to scale it and document it as standard practice.

---

## Summary — every file touched or created

| File | Change |
|---|---|
| `packages/core/src/db/migrations/002_add_preset_support.sql` | **New** |
| `packages/core/src/db/rows.ts` | Add `preset_id` to `SpaceRow` |
| `packages/core/src/domain/types.ts` | Add `presetId?` to `Space` |
| `packages/core/src/presets/spacePresets.ts` | **New** |
| `packages/core/src/presets/presets.json` | **New** (Section 5 content) |
| `packages/core/src/presets/spacePresets.test.ts` | **New** |
| `packages/core/src/index.ts` | Export presets module |
| `packages/core/scripts/copy-assets.mjs` | Add `copyPresets()` |
| `packages/core/src/db/repos/AgentRepo.ts` | Lock checks in create/update/delete |
| `packages/core/src/db/repos/SpaceRepo.ts` | Lock check in update; new `createFromPreset()`; `preset_id` in create/map |
| `packages/core/src/db/repos.test.ts` | New lock + createFromPreset tests |
| `packages/desktop/src/shared/ipc.ts` | New schema + 2 channels |
| `packages/desktop/src/main/ipcRouter.ts` | 2 new handlers, `PresetWithStatus` type |
| `packages/desktop/src/main/ipcRouter.test.ts` | New preset IPC tests |
| `packages/desktop/src/preload/index.ts` | `presets` API surface |
| `packages/desktop/src/renderer/src/view.ts` | `'gallery'` view |
| `packages/desktop/src/renderer/src/screens/PresetGalleryScreen.tsx` | **New** |
| `packages/desktop/src/renderer/src/screens/SpacesHomeScreen.tsx` | Two-button New Space row |
| `packages/desktop/src/renderer/src/App.tsx` | Wire gallery view |
| `packages/desktop/src/renderer/src/screens/SpaceBuilderScreen.tsx` | `isPreset` gating |
| `packages/desktop/src/renderer/src/components/AgentEditor.tsx` | `structureLocked` prop |

No changes needed to: `RunOrchestrator`, any strategy class, `RunManager`, `SettingsStore`, `McpClient`, `LmStudioClient`, `ConcurrencyLimiter`, or any existing screen not listed above (`RunScreen`, `RunHistoryScreen`, `McpRegistryScreen`, `SettingsScreen` are all untouched).
