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

## Phase 5 — Electron Shell & IPC Bridge

**Goal**: Desktop app hosts the engine; renderer talks only through typed IPC.

### Tasks

- [ ] Main process boot: open SQLite in `app.getPath('userData')`, run migrations, `RunRepo.markInterrupted()`, instantiate engine with settings
- [ ] Settings store (JSON file in userData): LM Studio base URL, concurrency cap, reports folder
- [ ] **Schema-first typed IPC contract** in a shared `packages/desktop/src/shared/ipc.ts`: one **Zod schema** per channel request/response; TS types derived via `z.infer<>` (single source of truth — compile-time types and runtime validation cannot drift). Channels for every repo + engine operation (`spaces:list`, `spaces:publish`, `runs:start`, `runs:stop`, `mcp:test`, `models:list`, `settings:get/set`, …) plus a push channel `runs:event` streaming RunEvents + status changes
- [ ] A `defineChannel(name, requestSchema, responseSchema)` helper drives both main-process handler registration and the preload client, so a channel without a schema is structurally impossible
- [ ] **Runtime validation at the trust boundary**: every main-process handler parses its payload with the channel schema before touching core; failures return `{ok:false, error:{code:'INVALID_PAYLOAD', details}}`. Zod validates *shape* only — business rules stay in core's validation module. Main→renderer event pushes are not runtime-validated (our own trusted output; YAGNI)
- [ ] Preload script exposing `window.acs` API (contextIsolation on, no node in renderer); renderer-side thin client with TypeScript types shared from the contract file
- [ ] Error convention: all IPC handlers return `{ok:true,data}|{ok:false,error:{code,message,details}}` — no thrown errors across the bridge

### Deliverables

- Renderer can list/create Spaces and receive live run events from a dev console (no real UI yet)

### Acceptance criteria

- Manual smoke: start a run from devtools console; events stream to renderer; stop works; app relaunch marks interrupted runs failed

---

## Phase 6 — Desktop UI

**Goal**: All five screens from DESIGN.md §4.8. Build in the order below — each step is independently usable.

### 6.1 Settings + MCP Registry

- [ ] Settings form: LM Studio URL + "Test connection" (calls `models:list`, shows model count or the guidance error), concurrency cap, reports folder picker
- [ ] MCP registry table: add/edit/remove (stdio: command, args, env editor; http: URL), enabled toggle, "Test connection" showing the server's tools or a structured error; delete-block dialog lists affected published Spaces

### 6.2 Spaces Home + Space Builder

- [ ] Home: card grid, status badges, New Space, delete with confirm (cascades)
- [ ] Builder: name/description; strategy picker with one-line explanations; default model dropdown (live from `models:list`, refresh button, stale-model warning); max rounds; MCP checklist from registry
- [ ] Agent list: add/edit/reorder (drag or up/down); per agent: name, role title, **auto-generated system prompt from role template** (editable in an "Advanced" expander), optional model override dropdown, orchestrator toggle (visible only for orchestrator strategy; enforces exactly one)
- [ ] UI hint when agent count exceeds 8 (soft recommendation, not a block)
- [ ] Publish button → validation issues rendered inline; published Space renders read-only with "Unpublish to edit"
- [ ] Ship 6–8 starter role templates (Researcher, Analyst, Writer, Coder, Reviewer, Critic, Planner, Domain Expert) as a static catalog: `core/src/templates/roles.json` bundled in `@acs/core` (each entry: `id`, `name`, `description`, `systemPromptTemplate` with `{{agentName}}`/`{{spaceDescription}}` placeholders), exposed via `listRoleTemplates()`. **Copy-on-create**: picking a template copies the rendered prompt into the agent's `system_prompt` — no ongoing reference, so template improvements in future versions never mutate existing Spaces, and edits don't "detach" anything. Not stored in SQLite (no seeding/migration/sync). User-defined custom templates: deferred, not v1

### 6.3 Run View + History

- [ ] Problem input (blocked when empty or Space busy) + Start
- [ ] Live feed: events grouped by round headers; agent messages with agent name/color; streaming tokens for the active agent; tool calls collapsed-expandable (args + result); system notices; auto-scroll with pause-on-user-scroll
- [ ] Stop button with confirm
- [ ] Completion panel: final answer rendered as markdown; **Open PDF** and **Show in folder** buttons; failed runs show the error prominently (e.g. missing-model guidance)
- [ ] History tab per Space: run list (status, date, rounds); opening a run replays its transcript from `run_events` using the same feed component

### Acceptance criteria

- Full manual flow with real LM Studio + one real MCP server: register MCP → create Space (2–3 agents, round-robin) → publish → submit problem → watch live collaboration → stop/restart → completed run shows final answer; history replays correctly
- Non-technical path check: a Space is creatable without ever opening an Advanced expander

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
