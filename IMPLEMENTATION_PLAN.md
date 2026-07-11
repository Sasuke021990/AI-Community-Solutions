# AI Community Solutions — Implementation Plan

**Companion to**: [DESIGN.md](DESIGN.md) (validated design, v1.0)
**Date**: 2026-07-11

The plan is phased so the core engine is provable early (via tests and a scratch script) before any UI exists. Each phase has explicit deliverables and acceptance criteria — do not start a phase until the previous one's criteria pass.

---

## Phase 0 — Repository Scaffolding

**Goal**: A working monorepo where both packages build, lint, and run tests.

### Tasks

- [ ] Initialize git repository and `.gitignore` (node_modules, dist, out, `*.db`, reports/)
- [ ] Root `package.json` with npm workspaces: `packages/core`, `packages/desktop`
- [ ] `packages/core`: plain TS library — `tsconfig.json` (strict mode, ES2022, NodeNext), build via `tsc`
- [ ] `packages/desktop`: scaffold with `electron-vite` (React + TypeScript template)
- [ ] Shared tooling: ESLint (flat config) + Prettier at root; scripts `build`, `lint`, `test` wired through workspaces
- [ ] Vitest configured in `packages/core`, one placeholder test passing
- [ ] Enforce the architectural rule: `packages/core` has **no** Electron imports (ESLint `no-restricted-imports` rule for `electron` in core)

### Deliverables

- `npm install && npm run build && npm test && npm run lint` all pass at root
- `npm run dev -w @acs/desktop` opens an empty Electron window

### Acceptance criteria

- Clean checkout builds on Windows with a single `npm install`
- Core package compiles standalone with zero Electron dependencies

---

## Phase 1 — Core Domain Model & Persistence

**Goal**: All domain types, SQLite storage, migrations, and repositories — fully unit/integration tested.

### Tasks

- [ ] Define domain types in `core/src/domain/`: `McpServerConfig`, `Space`, `Agent`, `Run`, `RunEvent` + enums (`Strategy`, `SpaceStatus`, `RunStatus`, `RunEventType`) exactly per DESIGN.md §4.2
- [ ] Install `better-sqlite3`; create `Database` wrapper that opens a DB file at a caller-supplied path (core never assumes Electron user-data dir)
- [ ] Migration runner: ordered `.sql` files in `core/src/db/migrations/`, applied inside a transaction, tracked in a `schema_migrations` table
- [ ] Migration 001: full schema from DESIGN.md §4.6 (all six tables, foreign keys ON, indices on `runs.space_id`, `run_events.run_id + seq`)
- [ ] Repositories (plain classes over the DB wrapper):
  - `McpServerRepo` — CRUD; delete blocked when referenced by any **published** Space (return affected Space names)
  - `SpaceRepo` — CRUD; edits refused when `status='published'`; `publish()` runs validation (≥1 agent; orchestrator flagged iff strategy is `orchestrator`; exactly one orchestrator); `unpublish()`
  - `AgentRepo` — CRUD within a Space; `position` ordering; edits refused when parent Space is published
  - `RunRepo` — create, status transitions, store final answer / pdf path / error; enforce **one active run per Space**; `markInterrupted()` (flips all `running` → `failed` with "interrupted" error — called at app startup)
  - `RunEventRepo` — append (auto-incrementing `seq` per run), list by run ordered by seq
- [ ] Validation module (used by `publish()` and later by the UI via IPC): returns structured issues, not thrown strings

### Deliverables

- `@acs/core` exports: domain types, `openDatabase(path)`, repository factory

### Acceptance criteria

- Integration tests (temp-file SQLite) cover: migrations idempotent on re-open; publish validation matrix (no agents / wrong orchestrator count / happy path); published-lock enforcement on Space and Agent edits; MCP delete-block; one-active-run rule; `markInterrupted`
- All tests pass with `npm test -w @acs/core`

---

## Phase 2 — LM Studio Client

**Goal**: A tested client for LM Studio's OpenAI-compatible API with streaming and tool-call support.

### Tasks

- [ ] `LmStudioClient` (fetch-based, no SDK dependency): constructor takes base URL (default `http://localhost:1234/v1`)
- [ ] `listModels()` → `GET /models`, returns model IDs; distinguishable errors: connection refused ("Is LM Studio running?") vs HTTP error
- [ ] `chat(request)` → `POST /chat/completions` with `stream: true`; parses SSE chunks; emits token deltas via callback; accumulates final message including `tool_calls`
- [ ] Request shape supports: `model`, `messages` (system/user/assistant/tool roles), `tools` (OpenAI function schema), `temperature`
- [ ] `ConcurrencyLimiter`: promise-queue capping in-flight `chat()` calls (**default 2**, injectable, Settings range 1–8) — conservative default because LM Studio on typical single-GPU hardware can crash or queue unboundedly when saturated
- [ ] **Stall detection** per request: first-token timeout (default 120s), inter-token stall timeout (default 60s without a chunk), whole-call ceiling (default 10 min). Tripping any → abort the request and fail the run with guidance ("model may be overloaded — reduce concurrency in Settings or use a smaller model"). **No automatic retry** (retrying an overloaded server doubles the load that caused the failure)
- [ ] Abort support: every call accepts an `AbortSignal` (needed for run Stop and stall aborts)

### Deliverables

- Client + limiter exported from `@acs/core`

### Acceptance criteria

- Unit tests against a local mock HTTP server (spun up in-test): model listing, streamed tokens arrive in order, tool_calls parsed from streamed chunks, abort mid-stream rejects cleanly, connection-refused produces the guidance error
- Limiter test: with cap 2 and 5 queued calls, never more than 2 in flight
- Stall tests (fake timers): first-token timeout fires when no chunk arrives; inter-token stall fires mid-stream; a steadily streaming call is never killed by either

---

## Phase 3 — MCP Manager

**Goal**: Launch, query, call, and shut down MCP servers from registry configs.

### Tasks

- [ ] Install `@modelcontextprotocol/sdk`
- [ ] `McpManager.connect(configs[])`: for each config, stdio transport (spawn command+args+env) or HTTP transport (URL); collect tools; namespace as `serverName__toolName`
- [ ] `listTools()` → merged, namespaced tool list converted to OpenAI function-schema format (for the LLM `tools` field)
- [ ] `callTool(namespacedName, args)` → routes to the right server; **any** failure (server crash, tool error, timeout) returns an error-text result object — never throws into the run
- [ ] Per-call timeout (default 60s, configurable)
- [ ] `testConnection(config)` → connect one server, return its tool list or a structured error (backs the registry UI's Test button)
- [ ] `disconnectAll()` — graceful shutdown, kills stdio child processes

### Deliverables

- `McpManager` exported from `@acs/core`

### Acceptance criteria

- Tests use a tiny stdio MCP test server fixture (few lines with the SDK) checked into the repo: connect, namespaced listing, successful call, failing tool returns error result (no throw), disconnect leaves no orphan process
- Startup failure of one server in `connect()` throws (preflight fail-fast is the caller's contract)

---

## Phase 4 — Run Engine & Coordination Strategies

**Goal**: The heart of the framework — deterministic, fully tested against fakes. After this phase the framework is usable from a script with real LM Studio.

### Tasks

- [ ] Define `CoordinationStrategy` interface: `execute(ctx: StrategyContext): Promise<StrategyResult>` where ctx exposes: agents, problem, `callAgent(agent, messages, opts)`, `emit(event)`, round bookkeeping, max rounds, abort signal
- [ ] **Completion signal**: agents declare done by ending a message with a tag-delimited block — `<final_answer>` … `</final_answer>` — containing the answer as plain markdown. No JSON, no escaping (small local models reliably fail at escaping quotes/newlines inside JSON strings). Tolerant parser: case-insensitive tags, closing tag optional at end-of-message, whitespace stripped. **Rule: all structured agent outputs (completion signal, orchestrator task assignments, debate no-objection markers) use tag-delimited formats, never JSON** — JSON appears only in API-enforced tool calls (decision from DESIGN.md §5 open items — locked here)
- [ ] `AgentCaller` shared primitive: builds system prompt (role + collaboration instructions + tool guidance + completion-signal instructions), runs the tool-call loop (LLM → tool_calls → McpManager → tool results → LLM, until no tool calls), appends `agent_message` / `tool_call` / `tool_result` events, one retry nudge on malformed tool JSON then plain-text fallback
- [ ] `OrchestratorStrategy`: orchestrator plans → task assignments parsed from tag-delimited blocks in its output (e.g. `<task agent="...">…</task>`) → independent tasks dispatched to workers concurrently (via limiter) → orchestrator reviews → iterate or final answer
- [ ] `RoundRobinStrategy`: fixed `position` order, sequential turns, each sees transcript-so-far; completion signal from any agent ends the run
- [ ] `DebateStrategy`: proposers (all non-critic rounds) draft concurrently → critique round → revise; converges when a critique round raises no blocking objections (tag marker `<no_objections/>`), else next round
- [ ] `RunEngine.startRun(spaceId, problem)`:
  1. Preflight: `listModels()` — every agent's effective model present, else fail fast naming model + agent; `McpManager.connect()` for allowed servers, else fail fast
  2. Create Run row, emit `round_start`/`system` events, execute strategy
  3. Max-round cap → synthesis call (Space default model) over transcript → best-effort final answer
  4. Persist final answer, invoke injected `ReportRenderer` + `PdfWriter` interfaces (PDF writing implemented in Phase 7 by desktop), close MCP, set final status
- [ ] `RunEngine.stopRun(runId)` → abort signal cascades; status `stopped`; partial transcript preserved
- [ ] Event streaming: engine exposes an event emitter per run (`onEvent(runId, cb)`) — persistence and live UI both consume it
- [ ] `FakeLlmClient` and `FakeMcpManager` test doubles with scripted responses

### Deliverables

- Fully working engine; a `scratch/run-demo.ts` script (not shipped) that runs a 2-agent round-robin Space against real LM Studio from the terminal

### Acceptance criteria

- Fake-driven tests per strategy: happy-path completion, max-round synthesis, tool-call loop, malformed-tool retry, concurrent worker dispatch (orchestrator), stop mid-run, preflight fail-fast (missing model halts before any agent speaks; names model + agent)
- Manual: demo script produces a coherent final answer with LM Studio running

---

## Phase 5 — Electron Shell & IPC Bridge ✅ (implemented as this repo's "Phase 4")

**Goal**: Desktop app hosts the engine; renderer talks only through typed IPC.

### Tasks

- [x] Main process boot: open SQLite in `app.getPath('userData')`, run migrations, `RunRepo.markInterrupted()`, instantiate engine with settings
- [x] Settings store (JSON file in userData): LM Studio base URL, concurrency cap, reports folder
- [x] **Schema-first typed IPC contract** in a shared `packages/desktop/src/shared/ipc.ts`: one **Zod schema** per channel request; TS types derived from the schema itself. Channels for every repo + engine operation plus push channels `runs:event` / `runs:status`. *Deviation:* response payloads are not given separate Zod schemas — they reuse `@acs/core`'s existing TS types directly, since they're our own trusted output and duplicating them in Zod would risk drifting from the domain types (consistent with Decision #21's rationale, extended from push-channels to responses generally).
- [x] A `defineChannel(name, requestSchema)` helper drives both main-process handler registration and the preload client
- [x] **Runtime validation at the trust boundary**: every handler parses its payload with the channel schema; failures return `{ok:false, error:{code:'INVALID_PAYLOAD', details}}`
- [x] Preload script exposing `window.acs` API (contextIsolation on); renderer-side types shared from the preload module
- [x] Error convention: `{ok:true,data}|{ok:false,error:{code,message,details}}` — no thrown errors across the bridge

### Deliverables

- [x] Renderer can list/create Spaces and receive live run events from a dev console (no real UI yet)

### Acceptance criteria

- [x] Manual smoke: start a run from devtools console; events stream to renderer; stop works; app relaunch marks interrupted runs failed — verified by actually launching the compiled Electron app (not just automated tests)

### Process fixes discovered only by booting the real app (none caught by lint/build/test until forced)

- `@acs/desktop` needed `"type": "module"` — `@acs/core` is ESM; Electron main can't `require()` it synchronously.
- Added `typecheck` scripts (`tsc --noEmit`) to both packages plus a root `verify` script, since `electron-vite`'s esbuild pipeline — like Vitest's — does not type-check and had already let two real type errors through undetected.
- `electron-vite` renames the preload bundle to `index.mjs` once the package is ESM; the hardcoded `index.js` path would have silently broken the preload bridge with no error at all.
- `better-sqlite3`'s native binding targets the system Node ABI, not Electron's bundled Node ABI. Added `@electron/rebuild` and a `postinstall: electron-rebuild -f -w better-sqlite3` script — the exact mitigation this plan's risk table below already called for.

---

## Phase 6 — Desktop UI ✅ (implemented as this repo's "Phase 5"; manual end-to-end flow still outstanding)

**Goal**: All five screens from DESIGN.md §4.8. Build in the order below — each step is independently usable.

### 6.1 Settings + MCP Registry

- [x] Settings form: LM Studio URL + "Test connection" (calls `models:list`, shows model count or the guidance error), concurrency cap, reports folder picker
- [x] MCP registry table: add/edit/remove (stdio: command, args, env editor; http: URL), enabled toggle, "Test connection" showing the server's tools or a structured error; delete-block dialog lists affected published Spaces

### 6.2 Spaces Home + Space Builder

- [x] Home: card grid, status badges, New Space, delete with confirm (cascades)
- [x] Builder: name/description; strategy picker with one-line explanations; default model dropdown (live from `models:list`, refresh button, stale-model warning); max rounds; MCP checklist from registry
- [x] Agent list: add/edit/reorder (up/down); per agent: name, role title, **auto-generated system prompt from role template** (editable in an "Advanced" expander), optional model override dropdown, orchestrator toggle (visible only for orchestrator strategy; correctness enforced server-side by publish validation, UI shows a hint rather than a hard client-side block)
- [x] UI hint when agent count exceeds 8 (soft recommendation, not a block)
- [x] Publish button → validation issues rendered inline; published Space renders read-only with "Unpublish to edit"
- [x] Ship 8 starter role templates (Researcher, Analyst, Writer, Coder, Reviewer, Critic, Planner, Domain Expert) as a static catalog: `core/src/templates/roles.json` bundled in `@acs/core`, exposed via `listRoleTemplates()` + `renderRoleTemplate()`. Rendering happens via a `templates:render` IPC channel (kept server-side so there is one source of truth, not duplicated in the renderer). Copy-on-create confirmed by test. Not stored in SQLite

### 6.3 Run View + History

- [x] Problem input (blocked when empty via disabled button, and hidden while the Space has an active run) + Start
- [x] Live feed: agent messages with per-turn headers (see deviation below), tool calls collapsed-expandable (args + result), system notices
- [ ] **Deviation**: events render chronologically by `seq` with each `round_start` event as a turn header, not grouped into strict "rounds" — the design's per-round grouping doesn't map cleanly onto orchestrator/debate's concurrent dispatch, where `Promise.all`-fired worker/proposer turns interleave by completion order rather than belonging to one clean round boundary
- [ ] Streaming tokens for the active agent — **not implemented**. The engine only emits a whole `agent_message` event per completed LLM call (established in Phase 3); wiring token-level streaming into the UI needs a new engine-level event type, out of scope for this pass
- [ ] Auto-scroll with pause-on-user-scroll — not implemented
- [x] Stop button — **no confirmation dialog** (direct stop); the plan called for "Stop button with confirm"
- [x] Completion panel: final answer rendered as markdown (dependency-free renderer, HTML-escaped before any tag insertion since the source is untrusted model output)
- [ ] **Open PDF** / **Show in folder** buttons — not implemented; PDF generation is Phase 7 and doesn't exist yet, so the panel shows "PDF report generation is not available yet" instead of a non-functional button
- [x] Failed runs show the error prominently
- [x] History tab per Space: run list (status, date, rounds); opening a run replays its transcript from `run_events` using the same `RunFeed` component the live view uses

### Acceptance criteria

- [ ] **Not yet verified**: full manual flow with real LM Studio + one real MCP server (register MCP → create Space → publish → submit problem → watch live collaboration → stop/restart → completed run shows final answer → history replays correctly). No native UI automation tool was available to click-test this; verification so far rests on strict `tsc --noEmit` across every screen, the full automated suite, and confirming the compiled app boots cleanly with zero renderer console errors (renderer console is now forwarded to the main process log specifically to make this checkable)
- [x] Non-technical path check: a Space is creatable without ever opening an Advanced expander (name + role-template pick is sufficient)

---

## Phase 7 — PDF Report

**Goal**: The deliverable artifact.

### Tasks

- [ ] `ReportRenderer` in `@acs/core`: Run + events + Space → self-contained HTML string. **Visual spec (locked)**: A4 portrait; all CSS inline; system font stack only (no webfonts); light/print theme with one neutral accent (dark slate) for headings/rules. Title page: product name small, Space name large, problem as block quote, date, models-used table. Body: final answer from markdown — h1–h3 scale, 11pt/1.5 body, bordered light-gray monospace code blocks, styled tables/lists. Appendix: per-round sections labeled by agent name + tool-usage summary table
- [ ] Page numbers/footer via `printToPDF`'s `footerTemplate` (not hand-rolled CSS counters)
- [ ] Desktop `PdfWriter`: hidden BrowserWindow → load HTML → `webContents.printToPDF` → save to `reports/<space>-<timestamp>.pdf` under the configured folder; store path on Run
- [ ] Wire into RunEngine finalize step; PDF failure does **not** fail the run (final answer already persisted; error noted as a system event)

### Acceptance criteria

- Unit test: renderer HTML contains problem, final answer, every round, tool names
- Manual: completed run produces a readable PDF; Open PDF / Show in folder work

---

## Phase 8 — E2E, Packaging & Polish

**Goal**: Shippable v1.

### Tasks

- [ ] Playwright + Electron smoke test: mock LM Studio HTTP server fixture → create Space → publish → run → assert completed status + PDF file exists
- [ ] `electron-builder` config: Windows NSIS installer, app icon, product name "AI Community Solutions"
- [ ] First-launch experience: if LM Studio unreachable, Settings screen opens with the guidance banner
- [ ] Empty states for all screens; loading states on model-list fetches
- [ ] README: prerequisites (LM Studio + a loaded tool-capable model), quick start, screenshots
- [ ] Version 0.1.0 tag

### Acceptance criteria

- E2E passes in CI-like conditions (no real LM Studio)
- Installer installs and runs on a clean Windows machine; full demo flow works with only LM Studio installed

---

## Cross-Cutting Rules (all phases)

1. **Core stays Electron-free** — enforced by lint rule from Phase 0.
2. **Every event is persisted before it is streamed** — the transcript in SQLite is the source of truth; the UI is a projection.
3. **No silent fallbacks** — missing model, unreachable LM Studio, MCP startup failure all halt loudly (per Decision #14).
4. **Typed boundaries** — domain types defined once in core; IPC contract is schema-first (Zod), types inferred from schemas, and every payload entering the main process is runtime-validated (Decision #21).
5. **Test-first for the engine** — Phase 4 strategies are written against the fakes before ever touching real LM Studio.

## Suggested Order & Dependencies

```
Phase 0 → 1 → 2 ┐
            3 ──┼→ 4 → 5 → 6 → 7 → 8
```

Phases 2 and 3 are independent of each other and can be done in either order (or interleaved). Phase 4 needs both. Everything UI (5–7) needs 4.

## Risks to Watch

| Risk | Mitigation |
|------|------------|
| Local models weak at tool calling / structured output | Tag-delimited signals (no JSON escaping required) + tolerant parsers + retry nudge (Phase 4); recommend tool-capable models in README |
| LM Studio crashes or queues unboundedly under concurrent load | Conservative limiter default (2, configurable 1–8); first-token/inter-token stall timeouts + whole-call ceiling abort hung requests; no automatic retry against an overloaded server |
| `better-sqlite3` native rebuild for Electron | Use `electron-rebuild` in postinstall; pin Electron + better-sqlite3 versions together |
| Long transcripts exceed model context | Strategies pass "relevant transcript" (recent rounds + summaries) — keep context-budgeting logic inside AgentCaller from day one |
