# Implementation Plan — Preset Guidance, Publish-Confirm Focus, and Webhook Data Sources

**Companion to**: [DESIGN.md](DESIGN.md), [PRESET_SPACES_DESIGN.md](PRESET_SPACES_DESIGN.md)
**Scope**: Two phases. Phase 1 = two small UX fixes. Phase 2 = webhook data sources (a substantial feature mirroring the MCP registry). This document is exhaustive by design — every file, field, signature, schema, and test is specified so implementation needs no further decisions.

---

## PHASE 1 — Preset "best for" guidance + Publish-confirm focus

### 1A. Preset "best for" guidance on gallery cards

**What**: Each preset shows a short "Best for…" line on its gallery card, so users know which method to reach for.

**Files & changes:**

1. **`packages/core/src/presets/spacePresets.ts`** — add `bestFor: string;` to the `SpacePreset` interface (after `description`).

2. **`packages/core/src/presets/presets.json`** — add a `"bestFor"` field to each of the 7 presets (place it right after `"description"`). Exact text:

   | Preset id | `bestFor` |
   |---|---|
   | `six-thinking-hats` | `Exploring a decision from every angle at once — facts, feelings, risks, benefits, and creativity — without it turning into one-sided debate.` |
   | `ooda-loop` | `Fast tactical decisions under time pressure or in fast-changing, uncertain situations.` |
   | `means-end-analysis` | `Goal-driven problems where you can define a clear target state and close the gap to it step by step.` |
   | `design-thinking` | `Human-centered problems with real users whose needs and pain points should drive the solution.` |
   | `triz` | `Inventive or technical problems that hit a hard trade-off or contradiction (improving X makes Y worse).` |
   | `alternative-approaches` | `When you want several genuinely different solution options generated and weighed against each other before committing.` |
   | `the-core-framework` | `General-purpose structured problem solving: isolate the root problem, break it down, test a fix, and iterate.` |

3. **`packages/desktop/src/renderer/src/screens/PresetGalleryScreen.tsx`** — inside each card, below the existing strategy/agents block, render:
   ```tsx
   <div style={{ fontSize: 12, marginBottom: 16 }}>
     <span style={{ color: 'var(--text-dim)' }}>Best for: </span>
     {preset.bestFor}
   </div>
   ```
   (`preset.bestFor` is already typed because `PresetWithStatus = SpacePreset & { existingSpaceId }`.)

4. **`packages/core/src/presets/spacePresets.test.ts`** — extend the roster test: assert every preset has a non-empty `bestFor` (`expect(p.bestFor.length).toBeGreaterThan(0)`).

**No IPC/schema change** — `presets:list` already returns the full `SpacePreset`, so the new field flows through automatically.

### 1B. Publish-confirm button focus

**What**: When the "Publish this Space?" confirm banner appears in the Space Builder, its **Confirm publish** button isn't focused, so Enter doesn't work. Fix: autofocus it when the banner opens.

**File**: `packages/desktop/src/renderer/src/screens/SpaceBuilderScreen.tsx`

**Changes:**
1. Add a ref near the other hooks: `const confirmBtnRef = useRef<HTMLButtonElement>(null);` (add `useRef` to the existing `react` import).
2. Add an effect:
   ```tsx
   useEffect(() => {
     if (confirmPublish) confirmBtnRef.current?.focus();
   }, [confirmPublish]);
   ```
3. On the existing "Confirm publish" button, add `ref={confirmBtnRef}`.

**Why a ref+effect, not `autoFocus`**: the confirm banner is conditionally rendered inside the same component (not remounted), so React's `autoFocus` prop is unreliable here — it only fires on initial mount, and the button may already be mounted/hidden depending on render path. The explicit effect keyed on `confirmPublish` is deterministic.

### Phase 1 verification
- `npm run verify` green.
- Manual: gallery cards show "Best for:" lines; clicking Publish focuses the confirm button so Enter confirms.

### Phase 1 files touched
`spacePresets.ts`, `presets.json`, `spacePresets.test.ts`, `PresetGalleryScreen.tsx`, `SpaceBuilderScreen.tsx`.

---

## PHASE 2 — Webhook Data Sources

**What**: A registry of HTTP data-source URLs (news/data endpoints) that agents can fetch from as a tool during a run. Mirrors the MCP registry: registered globally, selected per-Space, exposed to agents as callable tools. Per-webhook fixed-or-parameterized.

### 2.1 Domain model

**`packages/core/src/domain/types.ts`** — new interface:
```ts
export interface WebhookConfig {
  id: string;
  name: string;
  description: string;          // shown to the agent as the tool description
  method: 'GET' | 'POST';
  url: string;                  // for parameterized, may contain the {query} placeholder
  parameterized: boolean;       // true = agent supplies one `query` string argument
  headers?: Record<string, string>; // optional, e.g. { "Authorization": "Bearer ..." }
  enabled: boolean;
  createdAt: number;
}
```
Also add to the `Space` interface, right after `allowedMcpServerIds`:
```ts
allowedWebhookIds?: string[];
```

### 2.2 Migration

**New file `packages/core/src/db/migrations/003_add_webhooks.sql`:**
```sql
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('GET', 'POST')),
  url TEXT NOT NULL,
  parameterized INTEGER NOT NULL DEFAULT 0,
  headers TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS space_webhooks (
  space_id TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  PRIMARY KEY (space_id, webhook_id),
  FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
  FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
);
```
The migration runner picks it up automatically (globs `*.sql` in order). `spacePresets.test.ts`'s migration-idempotency test already covers re-open safety.

### 2.3 Row type

**`packages/core/src/db/rows.ts`** — add:
```ts
export interface WebhookRow {
  id: string;
  name: string;
  description: string;
  method: string;
  url: string;
  parameterized: number;
  headers: string | null;
  enabled: number;
  created_at: number;
}
```

### 2.4 WebhookRepo

**New file `packages/core/src/db/repos/WebhookRepo.ts`** — mirrors `McpServerRepo` exactly (CRUD + delete-block when referenced by a published Space via `space_webhooks`):
```ts
import { Database as SQLiteDatabase } from 'better-sqlite3';
import { WebhookConfig } from '../../domain/types.js';
import { WebhookRow } from '../rows.js';

export class WebhookRepo {
  constructor(private db: SQLiteDatabase) {}

  public create(w: WebhookConfig): void {
    this.db.prepare(`
      INSERT INTO webhooks (id, name, description, method, url, parameterized, headers, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      w.id, w.name, w.description, w.method, w.url, w.parameterized ? 1 : 0,
      w.headers ? JSON.stringify(w.headers) : null, w.enabled ? 1 : 0, w.createdAt
    );
  }

  public update(w: WebhookConfig): void {
    this.db.prepare(`
      UPDATE webhooks
      SET name = ?, description = ?, method = ?, url = ?, parameterized = ?, headers = ?, enabled = ?
      WHERE id = ?
    `).run(
      w.name, w.description, w.method, w.url, w.parameterized ? 1 : 0,
      w.headers ? JSON.stringify(w.headers) : null, w.enabled ? 1 : 0, w.id
    );
  }

  public list(): WebhookConfig[] {
    const rows = this.db.prepare('SELECT * FROM webhooks').all() as WebhookRow[];
    return rows.map(this.mapRow);
  }

  public delete(id: string): { success: boolean; affectedSpaces: string[] } {
    const affected = this.db.prepare(`
      SELECT s.name FROM spaces s
      JOIN space_webhooks sw ON s.id = sw.space_id
      WHERE sw.webhook_id = ? AND s.status = 'published'
    `).all(id) as { name: string }[];
    if (affected.length > 0) return { success: false, affectedSpaces: affected.map((r) => r.name) };
    this.db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
    return { success: true, affectedSpaces: [] };
  }

  private mapRow(row: WebhookRow): WebhookConfig {
    return {
      id: row.id, name: row.name, description: row.description,
      method: row.method as 'GET' | 'POST', url: row.url,
      parameterized: row.parameterized === 1,
      headers: row.headers ? (JSON.parse(row.headers) as Record<string, string>) : undefined,
      enabled: row.enabled === 1, createdAt: row.created_at
    };
  }
}
```
Export it from **`packages/core/src/db/repos/index.ts`** and wire it into **`packages/core/src/db/factory.ts`** `Repositories` interface + `createRepositories()` (add `webhooks: new WebhookRepo(sqlite)`).

### 2.5 SpaceRepo — persist & load allowed webhooks

Mirror the existing `allowedMcpServerIds` handling in **`packages/core/src/db/repos/SpaceRepo.ts`**:
- **`create()`** and **`update()`**: after `setAllowedMcpServers`, add the same for webhooks:
  ```ts
  if (space.allowedWebhookIds) this.setAllowedWebhooks(space.id, space.allowedWebhookIds);
  ```
- New private methods (copy of the MCP ones against `space_webhooks`):
  ```ts
  private setAllowedWebhooks(spaceId: string, ids: string[]) {
    this.db.prepare('DELETE FROM space_webhooks WHERE space_id = ?').run(spaceId);
    const insert = this.db.prepare('INSERT INTO space_webhooks (space_id, webhook_id) VALUES (?, ?)');
    for (const id of ids) insert.run(spaceId, id);
  }
  private getAllowedWebhooks(spaceId: string): string[] {
    const rows = this.db.prepare('SELECT webhook_id FROM space_webhooks WHERE space_id = ?').all(spaceId) as { webhook_id: string }[];
    return rows.map((r) => r.webhook_id);
  }
  ```
- **`mapRowToSpace()`**: add `allowedWebhookIds: this.getAllowedWebhooks(row.id)`.
- **`createFromPreset()`**: no change needed — presets ship with no webhooks selected (`allowedWebhookIds` undefined → skipped). Webhooks remain editable on a preset Space (they're in the same "editable on preset" bucket as MCP servers; the preset lock in `update()` only guards name/description/strategy, so `allowedWebhookIds` flows through untouched).

### 2.6 WebhookClient (core, no Electron dep)

**New file `packages/core/src/webhooks/WebhookClient.ts`** — performs the actual fetch, used by both the run engine and the "test" IPC handler:
```ts
import { WebhookConfig } from '../domain/types.js';

const MAX_RESPONSE_CHARS = 8000;   // protect model context
const TIMEOUT_MS = 30_000;

export interface WebhookFetchResult {
  ok: boolean;
  status?: number;
  body: string;   // (possibly minified+truncated) response text, or an error message
}

/**
 * Minifies the body if it's valid JSON (re-stringified with no whitespace,
 * so the 8KB cap holds more signal), otherwise leaves it as-is (HTML, RSS,
 * plain text). Truncation always happens after minification.
 */
function compactAndTruncate(text: string): string {
  let body = text;
  try {
    body = JSON.stringify(JSON.parse(text));
  } catch {
    // Not JSON - use the raw text.
  }
  return body.length > MAX_RESPONSE_CHARS
    ? body.slice(0, MAX_RESPONSE_CHARS) + `\n...[truncated ${body.length - MAX_RESPONSE_CHARS} chars]`
    : body;
}

export async function fetchWebhook(w: WebhookConfig, query?: string): Promise<WebhookFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let url = w.url;
    const init: RequestInit = { method: w.method, headers: { ...(w.headers ?? {}) }, signal: controller.signal };

    if (w.parameterized) {
      const q = query ?? '';
      // URL substitution and POST-body substitution are independent, not
      // method-gated: a POST to a REST-style path (/search/{query}) needs
      // URL substitution; a POST to a fixed endpoint needs the JSON body;
      // some APIs could want both. GET only ever uses the URL.
      if (url.includes('{query}')) {
        url = url.replaceAll('{query}', encodeURIComponent(q));
      } else if (w.method === 'GET') {
        url = url + (url.includes('?') ? '&' : '?') + 'query=' + encodeURIComponent(q);
      }
      if (w.method === 'POST') {
        (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
        init.body = JSON.stringify({ query: q });
      }
    } else if (w.method === 'POST') {
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
      init.body = '{}';
    }

    const res = await fetch(url, init);
    const text = await res.text();
    const body = compactAndTruncate(text);
    if (!res.ok) return { ok: false, status: res.status, body: `HTTP ${res.status}: ${body.slice(0, 500)}` };
    return { ok: true, status: res.status, body };
  } catch (e) {
    const msg = e instanceof Error && e.name === 'AbortError' ? `Timed out after ${TIMEOUT_MS}ms` : (e instanceof Error ? e.message : String(e));
    return { ok: false, body: `Fetch failed: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}
```
Export from **`packages/core/src/index.ts`**: `export * from './webhooks/WebhookClient.js';`

### 2.7 Engine integration (RunOrchestrator + RunManager + ExecutionState)

**`packages/core/src/engine/strategies/AgentStrategy.ts`** — no change; `state.tools` and `state.callTool` already carry all tools generically.

**`packages/core/src/engine/RunOrchestrator.ts`:**
- Constructor gains a parameter `webhooks: WebhookConfig[]` (after `mcpClients`). Store as `private webhooks`.
- Add `private webhookMap = new Map<string, WebhookConfig>();`
- In **`buildToolRegistry()`**, after the MCP loop, add webhook tools:
  ```ts
  for (const w of this.webhooks) {
    if (!w.enabled) continue;
    const name = `webhook__${w.name.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    this.webhookMap.set(name, w);
    this.state.tools.push({
      type: 'function',
      function: {
        name,
        description: w.description || `Fetch data from the "${w.name}" webhook.`,
        parameters: w.parameterized
          ? { type: 'object', properties: { query: { type: 'string', description: 'The search term or input to send.' } }, required: ['query'] }
          : { type: 'object', properties: {} }
      }
    });
  }
  ```
- In **`callTool(name, args)`**, check the webhook map first:
  ```ts
  const wh = this.webhookMap.get(name);
  if (wh) {
    const query = typeof args.query === 'string' ? args.query : undefined;
    const result = await fetchWebhook(wh, query);
    return result.body;   // body already holds error text on failure (non-fatal)
  }
  // ...existing MCP toolMap routing...
  ```
- Import `WebhookConfig` and `fetchWebhook` from the appropriate core paths.

**`packages/desktop/src/main/RunManager.ts`** — in `startRun`, after building `mcpClients`, select allowed webhooks and pass them through:
```ts
const webhooks = this.repos.webhooks
  .list()
  .filter((w) => w.enabled && (space.allowedWebhookIds ?? []).includes(w.id));
```
Pass `webhooks` into the `new RunOrchestrator(...)` call (new argument after `mcpClients`).

### 2.8 IPC layer

**`packages/desktop/src/shared/ipc.ts`:**
```ts
const WebhookBaseSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  method: z.enum(['GET', 'POST']),
  url: z.string().url(),
  parameterized: z.boolean().default(false),
  headers: z.record(z.string()).optional(),
  enabled: z.boolean().default(true)
});
export const WebhookInputSchema = WebhookBaseSchema;
export const WebhookUpdateSchema = WebhookBaseSchema.extend({ id: z.string().min(1) });
```
Extend `SpaceInputSchema` (and therefore `SpaceUpdateSchema`, which extends it) with:
```ts
allowedWebhookIds: z.array(z.string()).optional()
```
New channels in the `Channels` registry:
```ts
webhooksList: defineChannel('webhooks:list', EmptySchema),
webhooksCreate: defineChannel('webhooks:create', WebhookInputSchema),
webhooksUpdate: defineChannel('webhooks:update', WebhookUpdateSchema),
webhooksDelete: defineChannel('webhooks:delete', IdSchema),
webhooksTest: defineChannel('webhooks:test', WebhookInputSchema)
```

**`packages/desktop/src/main/ipcRouter.ts`** — import `fetchWebhook` from `@acs/core`. Handlers (mirroring the MCP ones):
```ts
[Channels.webhooksList.name]: async () => repos.webhooks.list(),

[Channels.webhooksCreate.name]: async (p) => {
  const input = Channels.webhooksCreate.requestSchema.parse(p);
  const config = { id: randomUUID(), createdAt: Date.now(), ...input };
  repos.webhooks.create(config);
  return config;
},

[Channels.webhooksUpdate.name]: async (p) => {
  const input = Channels.webhooksUpdate.requestSchema.parse(p);
  const existing = repos.webhooks.list().find((w) => w.id === input.id);
  if (!existing) throw new Error('Webhook not found');
  repos.webhooks.update({ ...existing, ...input });
  return undefined;
},

[Channels.webhooksDelete.name]: async (p) => {
  const { id } = Channels.webhooksDelete.requestSchema.parse(p);
  return repos.webhooks.delete(id);
},

[Channels.webhooksTest.name]: async (p) => {
  const input = Channels.webhooksTest.requestSchema.parse(p);
  const w = { id: 'test', createdAt: Date.now(), ...input };
  const r = await fetchWebhook(w, input.parameterized ? 'test' : undefined);
  return { ok: r.ok, status: r.status, snippet: r.body.slice(0, 500) };
}
```

**`packages/desktop/src/preload/index.ts`** — new `webhooks` section on the `api` object + a `WebhookInput` interface:
```ts
export interface WebhookInput {
  name: string; description?: string; method: 'GET' | 'POST';
  url: string; parameterized?: boolean; headers?: Record<string, string>; enabled?: boolean;
}
export interface WebhookTestResult { ok: boolean; status?: number; snippet: string; }
// ...
webhooks: {
  list: () => invoke<WebhookConfig[]>(Channels.webhooksList.name),
  create: (input: WebhookInput) => invoke<WebhookConfig>(Channels.webhooksCreate.name, input),
  update: (input: WebhookInput & { id: string }) => invoke<void>(Channels.webhooksUpdate.name, input),
  delete: (id: string) => invoke<DeleteMcpResult>(Channels.webhooksDelete.name, { id }),
  test: (input: WebhookInput) => invoke<WebhookTestResult>(Channels.webhooksTest.name, input)
},
```
(Add `WebhookConfig` to the `@acs/core` type import. `DeleteMcpResult` is reused since the delete shape is identical: `{ success, affectedSpaces }`.)

### 2.9 UI

**A. Webhook registry — on the MCP Servers screen, below the server table** (matching "below MCP setting a section for add webhooks"):

`packages/desktop/src/renderer/src/screens/McpRegistryScreen.tsx` — rename the screen's `<h1>` context is kept, but append a second section after the servers table: a **"Webhook Data Sources"** heading, an "Add webhook" button, an add/edit form, and a table. To keep the file manageable, extract the webhook section into a **new component `packages/desktop/src/renderer/src/screens/WebhookRegistrySection.tsx`** and render `<WebhookRegistrySection />` at the bottom of `McpRegistryScreen`. The section mirrors the MCP form/table:
- **Form fields**: Name; Description; Method (GET/POST select); URL (with hint: *"For a parameterized webhook, put `{query}` where the input should go, e.g. `https://api.example.com/news?q={query}`"*); Parameterized (checkbox); Headers (one `KEY=VALUE` per line, same parser as MCP env); Enabled (checkbox).
- **Buttons**: Add/Save, **Test** (calls `webhooks.test`, shows status + snippet), Cancel.
- **Table columns**: Name, Method, Parameterized (Yes/No), Enabled, Edit/Delete — **deliberately no Headers column**, matching the MCP servers table's existing treatment of `env` (secrets are only ever visible in the edit form you deliberately open, never in the passive list view). Delete-block dialog reuses the same "used by published Space(s)" banner pattern.

**B. Space Builder — "Allowed webhooks" checklist:**

`packages/desktop/src/renderer/src/screens/SpaceBuilderScreen.tsx`:
- Load webhooks alongside MCP servers: add `const [webhooks, setWebhooks] = useState<WebhookConfig[]>([]);` and `call(window.acs.webhooks.list()).then(setWebhooks).catch(() => {});` in the mount effect.
- Add `allowedWebhookIds: string[]` to the `SpaceForm` interface, `toForm`, and `emptyForm` (default `[]`); include it in the `createSpace`/`saveSpace` payloads (the space create/update already spreads `form`).
- Add a `toggleWebhook(id)` mirroring `toggleMcp`.
- Render an **"Allowed webhooks"** checklist directly below the existing "Allowed MCP servers" field, same markup, `disabled={isPublished}` (editable on preset Spaces, like MCP).

### 2.10 Tests

- **`packages/core/src/db/repos.test.ts`** (append): WebhookRepo create/list/update/delete round-trip; delete blocked when referenced by a published Space (mirror the existing MCP delete-block test); SpaceRepo persists & loads `allowedWebhookIds`.
- **New `packages/core/src/webhooks/WebhookClient.test.ts`** (mock `global.fetch`): fixed GET hits the URL as-is; parameterized GET substitutes `{query}` (URL-encoded); parameterized GET without `{query}` appends `?query=`; parameterized POST with no `{query}` in the URL sends `{query}` in the JSON body only; parameterized POST with `{query}` **in the URL** substitutes the URL **and still** sends the JSON body (both, independently - the fix from the POST-URL-substitution question); non-2xx returns `ok:false` with `HTTP <status>`; a JSON response body is re-stringified compact (no whitespace) before truncation; a non-JSON response (e.g. HTML) is left as raw text; oversized body is truncated with the `[truncated N chars]` marker (measured after minification); abort/timeout returns `ok:false` with a timeout message.
- **`packages/desktop/src/main/ipcRouter.test.ts`** (append): webhooks create/list/delete via channels; `webhooks:test` returns `{ok,status,snippet}` against a mocked fetch; delete-block surfaces `{success:false, affectedSpaces}`.
- **`packages/core/src/engine/strategies/strategies.test.ts`** or a RunOrchestrator test: with one parameterized webhook registered, `state.tools` includes a `webhook__<name>` entry with a `query` param, and `state.callTool('webhook__<name>', {query:'x'})` returns the fetched body (via a fake `fetchWebhook`/mocked fetch).

### 2.11 Build assets
No new non-`.ts` runtime assets, so `copy-assets.mjs` is unchanged (the migration `.sql` is already globbed by `copyMigrations()`; confirm it copies `003_add_webhooks.sql` — it copies the whole migrations dir, so yes automatically).

### Phase 2 verification
- `npm run verify` green (lint + typecheck + build + test).
- Prove the built `dist` applies migration 003 and `fetchWebhook` works, via a scratch probe (same approach used for presets).
- Manual: register a webhook (fixed + parameterized), Test it, select it in a Space, run a problem, confirm an agent calls `webhook__…` and the fetched data appears in the transcript tool-result.

### Phase 2 — every file touched or created
| File | Change |
|---|---|
| `packages/core/src/db/migrations/003_add_webhooks.sql` | **New** |
| `packages/core/src/domain/types.ts` | `WebhookConfig` + `Space.allowedWebhookIds` |
| `packages/core/src/db/rows.ts` | `WebhookRow` |
| `packages/core/src/db/repos/WebhookRepo.ts` | **New** |
| `packages/core/src/db/repos/index.ts` | export WebhookRepo |
| `packages/core/src/db/factory.ts` | wire `webhooks` repo |
| `packages/core/src/db/repos/SpaceRepo.ts` | allowed-webhooks persist/load |
| `packages/core/src/webhooks/WebhookClient.ts` | **New** |
| `packages/core/src/index.ts` | export WebhookClient |
| `packages/core/src/engine/RunOrchestrator.ts` | webhook tools + callTool routing + ctor param |
| `packages/desktop/src/main/RunManager.ts` | select + pass allowed webhooks |
| `packages/desktop/src/shared/ipc.ts` | webhook schemas + channels + `allowedWebhookIds` |
| `packages/desktop/src/main/ipcRouter.ts` | webhook handlers |
| `packages/desktop/src/preload/index.ts` | `webhooks` API + types |
| `packages/desktop/src/renderer/src/screens/WebhookRegistrySection.tsx` | **New** |
| `packages/desktop/src/renderer/src/screens/McpRegistryScreen.tsx` | render the webhook section |
| `packages/desktop/src/renderer/src/screens/SpaceBuilderScreen.tsx` | allowed-webhooks checklist |
| `packages/core/src/db/repos.test.ts` | WebhookRepo + SpaceRepo tests |
| `packages/core/src/webhooks/WebhookClient.test.ts` | **New** |
| `packages/desktop/src/main/ipcRouter.test.ts` | webhook IPC tests |
| `packages/core/src/engine/strategies/strategies.test.ts` | webhook-as-tool test |

Not touched: RunScreen, RunHistoryScreen, SettingsScreen, all engine strategies, LmStudioClient, ConcurrencyLimiter, McpClient.

---

## Decision Log (this plan)

| # | Decision | Alternative | Why |
|---|---|---|---|
| 1 | Ship as two phases; Phase 1 first | One big batch | Phase 1 is trivial + high-value; webhooks is large. Land value early. |
| 2 | Publish focus via ref+effect keyed on `confirmPublish` | React `autoFocus` prop | Conditional-render-in-place makes `autoFocus` unreliable; effect is deterministic. |
| 3 | Webhooks mirror the MCP registry (global registry + per-Space checklist) | A brand-new subsystem | Reuses proven patterns (repo, delete-block, tool exposure) and is familiar to the user. |
| 4 | Webhook tools merged into the same `state.tools` / `callTool` path as MCP | A separate agent tool channel | The engine's tool loop is already generic; one path keeps AgentCaller untouched. |
| 5 | Response truncated to 8 KB, failures non-fatal (error string to agent) | Unbounded body; throw on failure | Protects local model context; matches MCP tool-failure semantics. |
| 6 | Webhook section lives on the MCP Servers screen, below the table | New top-level sidebar item | Matches the user's "below MCP setting" wording; avoids nav sprawl. |
| 7 | Webhooks editable on preset & draft Spaces (not a locked field) | Lock like agent roster | They're install-specific data sources, same bucket as MCP servers — tuning, not structure. |
| 8 | GET+POST, `{query}` placeholder substitution, optional headers | GET-only fixed URLs | Real data APIs need params and API-key headers; still simple. |
| 9 | URL `{query}` substitution and POST JSON-body substitution are independent (not method-gated) | Body-only for POST, ignoring `{query}` in a POST URL | A POST to a REST-style path (`/search/{query}`) needs URL substitution too; silently dropping it would surprise the user with an unsubstituted literal `{query}` in the request |
| 10 | Header secrets stored in plaintext SQLite, never rendered in the webhook table (only in the edit form) | Mask/encrypt header values | Matches existing precedent for MCP `env` (DESIGN.md Assumption 8); masking only webhooks while MCP stays plaintext would be an inconsistent standard for equivalent secrets in the same app; a real masked-field UI doesn't fit the shared free-text textarea MCP already established |
| 11 | Minify JSON response bodies before the 8KB truncation cap; leave non-JSON as-is | Truncate raw text always | Reclaims wasted whitespace budget for actual content, at zero cost when the response isn't JSON (parse just fails and falls through) |
