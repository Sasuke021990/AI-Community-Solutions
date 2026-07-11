# AI Community Solutions — Design Document

**Status**: Validated design (brainstorming phase complete)
**Date**: 2026-07-11
**Version**: 1.0

---

## 1. Understanding Summary

- **What**: "AI Community Solutions" — a framework (`@acs/core`, pure TypeScript/Node) plus an Electron desktop app (`@acs/desktop`), where a user creates **Spaces** (a.k.a. Communities) populated with role-configured AI agents wired to MCP tools.
- **Why**: Let a user hand a problem to a team of specialized local agents that collaborate autonomously — using a coordination pattern chosen per Space — until they converge on a solution and deliver output.
- **Who**: A single local user; two usability tiers — non-technical users get a short default path (name + role per agent, auto-generated prompts), power users get full control over prompts, models, and settings.
- **LLM backend**: LM Studio only (local, OpenAI-compatible API). No cloud/remote LLMs in v1.
- **MCP tools**: Registered globally in the app; each Space selects which registered MCPs it allows. Tool access is **space-wide** (all agents in a Space share the same tool set).
- **Per-agent models**: Each agent may be assigned its own model (live dropdown from LM Studio `/v1/models`); a Space-level default applies otherwise.
- **Coordination**: Chosen per Space: `orchestrator` | `round-robin` | `debate`.
- **Completion**: Agents can declare done; a configurable max-round cap forces termination with a best-effort synthesis.
- **Publish**: Locks a Space's configuration and activates it as runnable. Not a sharing feature.
- **Output**: Final answer shown in-app **and** delivered as a generated PDF report.
- **Persistence**: SQLite, local, single file.

### Non-Goals (v1)

- No cloud/remote LLM support (LM Studio only)
- No multi-user, accounts, sharing, or marketplace
- No mobile app
- Text-based agent collaboration only (tools may return artifacts, but reasoning is text)
- No run resume after app crash (partial transcript preserved, run marked failed)

---

## 2. Assumptions

1. No multi-user/sharing/marketplace features in v1.
2. No mobile companion app in v1.
3. Agent-to-agent collaboration is text-based.
4. "Space" and "Community" are the same concept.
5. A Space is reusable — many runs over time, each with its own history/output.
6. LM Studio base URL is configurable (default `http://localhost:1234/v1`); the framework does not manage model loading inside LM Studio.
7. Editing a published Space requires an explicit "Unpublish" action.
8. MCP credentials/secrets are stored locally in SQLite without OS-keychain hardening (single-user local tool).
9. **Confirmed rule**: if any agent's assigned model is unavailable at run time, the run fails fast with a clear error and **halts the entire Space execution** — no fallback.
10. The final answer is shown in the app as text; the PDF is the formal deliverable saved to disk.
11. No hard agent-count limit per Space; UI recommends ~2–8 agents given local hardware.

---

## 3. Decision Log

| # | Decision | Alternatives considered | Rationale |
|---|----------|------------------------|-----------|
| 1 | Hybrid: core framework + UI on top | Web SaaS; dev-only library; CLI tool | Framework reusability plus approachable UI |
| 2 | Serve both technical and non-technical users (tiered UX) | Developers only; no-code only | Widest usefulness; defaults + advanced sections |
| 3 | LM Studio as the only LLM backend | Generic OpenAI-compatible; multi-provider | User's explicit choice; simplest v1 |
| 4 | Coordination strategy configurable per Space | Fixed orchestrator; fixed round-robin; fixed debate | Different problems suit different patterns |
| 5 | Publish = lock config + activate | Shareable/discoverable publishing; both | Single-user scope; keeps publish meaningful |
| 6 | Global MCP registry; per-Space allowed subset; space-wide agent access | Per-agent tool assignment; built-in catalog only | User's explicit choice; simpler configuration |
| 7 | Completion = agent-declared done + max-round cap with synthesis fallback | Agent-declared only; fixed rounds only | Guarantees termination and always yields output |
| 8 | Desktop app as primary interface | Local web UI; CLI-first | User's explicit choice |
| 9 | Single-user, local-only | Multi-user with accounts | Matches LM Studio's local nature; no auth complexity |
| 10 | Electron + Node.js/TypeScript | Tauri + Rust; Python backend | Best MCP SDK support (TS-first); mature desktop tooling |
| 11 | Concurrent LLM calls within a Space (engine limiter, default cap 4) | Strictly sequential; user-configurable limit | User's choice; limiter protects local hardware |
| 12 | SQLite via better-sqlite3 | Flat JSON/YAML files | Structured queries over run history; single-file backup |
| 13 | Per-agent model assignment; live model list from `/v1/models`; Space default fallback | Typed model IDs; one model per Space | User's explicit request; live list avoids typos |
| 14 | Missing model at runtime → fail fast, halt entire run | Fallback to default model; skip agent | User's explicit rule; predictable behavior |
| 15 | Final output = PDF report (+ in-app text) | Markdown only; structured artifacts | User's explicit choice |
| 16 | Architecture A: monorepo — `@acs/core` package + Electron app over typed IPC | B: local server + thin client; C: single Electron codebase | Framework reusability without server-layer overhead (YAGNI) |
| 17 | PDF via Electron `webContents.printToPDF` from HTML | Native PDF libs (pdfkit, puppeteer) | Zero extra native deps; core stays Electron-free via `ReportRenderer` interface |
| 18 | One active run per Space at a time (v1) | Parallel runs per Space | Simplicity; local hardware constraints |
| 19 | All structured agent outputs (completion signal, task assignments, debate markers) use **tag-delimited plain text** (`<final_answer>…</final_answer>`), never JSON | Fenced JSON blocks; sentinel token lines | Small local models reliably fail at escaping quotes/newlines inside JSON strings; tags need no escaping and are well-represented in training data. JSON remains only in API-enforced tool calls |
| 20 | Role templates: static `roles.json` bundled in `@acs/core`, **copy-on-create** into the agent's `system_prompt`; no custom templates in v1 | SQLite-stored templates (seedable/user-editable); templates referenced by ID at run time | No seeding/migration logic; future template improvements never silently change existing Spaces; users effectively customize by editing the copied prompt |
| 21 | IPC contract is **schema-first with Zod**: types derived via `z.infer<>`, every main-process handler runtime-validates its payload at the boundary | Compile-time-only shared TS types; validating in both directions | TS types alone don't exist at runtime — malformed renderer payloads would reach SQLite unchecked. One schema definition prevents type/validator drift; main→renderer pushes stay unvalidated (own trusted output) |
| 22 | Concurrency limiter default **2** (range 1–8) with stall detection: first-token timeout 120s, inter-token stall 60s, whole-call ceiling 10 min; no automatic retry on timeout | Default 4 with no timeouts; adaptive/backoff retry schemes | LM Studio can crash or queue endlessly when saturated on local hardware; stall timeouts convert silent hangs into loud failures, and retrying an overloaded server doubles the load that caused the failure |
| 23 | PDF visual spec locked: A4, inline CSS, system fonts only, light/print theme with single dark-slate accent, `footerTemplate` page numbers | Webfonts/branded design; leaving CSS to implementation discretion | Self-contained output with no licensing/offline concerns; a fixed spec prevents ad-hoc design during Phase 7 |

---

## 4. Final Design

### 4.1 Repository Layout

```
ai-community-solutions/
├── packages/
│   ├── core/        # @acs/core — the framework (pure Node/TS, no Electron)
│   └── desktop/     # @acs/desktop — Electron app (React + Vite renderer)
```

npm workspaces monorepo. `@acs/core` has a documented public API so future consumers (CLI, web UI) need no rework.

### 4.2 Domain Model

- **McpServerConfig** — globally registered MCP server: name, transport (`stdio` command+args+env, or `http` URL), enabled flag.
- **Space** — name, description, strategy (`orchestrator` | `round-robin` | `debate`), default model ID, max rounds, allowed MCP server IDs, status (`draft` | `published`), agents.
- **Agent** — belongs to a Space: name, role title, system prompt, optional model ID (falls back to Space default), `is_orchestrator` flag (orchestrator strategy only), position (turn order).
- **Run** — one problem submitted to a published Space: problem text, status (`running` | `completed` | `failed` | `stopped`), rounds used, final answer, PDF path, error, timestamps.
- **RunEvent** — append-only transcript: `agent_message` | `tool_call` | `tool_result` | `round_start` | `system`, with agent ref, JSON payload, sequence number.

**Process placement**: `@acs/core` runs in Electron's main process. The renderer never touches SQLite/LM Studio/MCP directly — commands and event streams flow over typed IPC through a preload bridge (`contextIsolation` on).

**Publish validation**: ≥1 agent; orchestrator designated when that strategy is chosen; models resolvable. Lock is enforced by refusing edits while `status='published'`; Unpublish returns to draft.

### 4.3 Run Engine

1. **Preflight**
   - `GET /models` on LM Studio; verify every referenced model. Miss → fail fast, halt run, error names the model and agent.
   - Launch/connect the Space's allowed MCP servers; collect tool definitions. Server fails to start → fail fast.
2. **Execute strategy** — pluggable modules behind `CoordinationStrategy.execute(context)`. Shared primitives: call an agent (system prompt = role + collaboration instructions; context = problem + relevant transcript), tool-call loop mid-turn, append every event to the transcript.
   - **Orchestrator**: designated agent decomposes the problem, assigns subtasks (independent subtasks run concurrently), reviews, iterates or declares done.
   - **Round-robin**: fixed turn order; each agent sees the discussion and contributes; any agent may declare completion via the tag-delimited signal; sequential.
   - **Debate**: proposers draft concurrently, critics attack, proposers revise; converges when no blocking objections remain.
3. **Termination** — explicit completion signal (agent ends a message with `<final_answer>…</final_answer>`, plain markdown inside, parsed tolerantly — no JSON escaping required of the model), or max-round cap → one final synthesis call producing a best-effort answer from the transcript. Manual Stop available anytime.
4. **Finalize** — final answer stored, PDF generated, MCP connections closed.

### 4.4 LM Studio Client

- Thin client over the OpenAI-compatible API; configurable base URL (default `http://localhost:1234/v1`); no API key.
- `GET /models` (dropdowns + preflight), `POST /chat/completions` (streamed for live UI tokens).
- Tool use via standard OpenAI `tools`/`tool_calls`. Models that ignore tools just answer in text (UI hints at possibly non-tool-capable models).
- In-engine concurrency limiter, **default 2** in-flight requests (Settings range 1–8) — LM Studio on typical single-GPU hardware can crash or queue unboundedly when saturated.
- Stall detection per request: first-token timeout (120s), inter-token stall timeout (60s), whole-call ceiling (10 min). Any trip aborts the request and fails the run with overload guidance; no automatic retry.
- Connection errors → run fails with "Is LM Studio running?" guidance.

### 4.5 MCP Manager

- Built on the official `@modelcontextprotocol/sdk` (TypeScript); stdio + HTTP transports.
- Registry UI has "Test connection" (connects and lists tools).
- At run start only the Space's allowed servers launch; tools namespaced `serverName__toolName`; offered to all agents in the Space; servers shut down at run end.
- Tool-call failure is non-fatal: error text returned to the agent as the tool result.

### 4.6 Persistence (SQLite via better-sqlite3)

```
mcp_servers   id, name, transport ('stdio'|'http'), command, args(json),
              env(json), url, enabled, created_at
spaces        id, name, description, strategy, default_model,
              max_rounds, status ('draft'|'published'), created_at, updated_at
space_mcp     space_id → mcp_server_id
agents        id, space_id, name, role, system_prompt,
              model_id (nullable), is_orchestrator, position
runs          id, space_id, problem, status, rounds_used,
              final_answer, pdf_path, error, started_at, finished_at
run_events    id, run_id, seq, type, agent_id, payload(json), at
```

Single DB file in the app's user-data directory. Ordered, versioned SQL migration files run by a tiny migration runner.

### 4.7 PDF Report

- Core exposes a `ReportRenderer` interface producing HTML; the desktop package prints it via Electron `webContents.printToPDF` (no extra native deps; core stays Electron-free).
- Contents: title page (Space name, problem, date, models used) → **final solution** (main body) → appendix (per-round contributions, tools used).
- Visual spec: A4 portrait; inline CSS only; system font stack (no webfonts); light/print theme, single dark-slate accent; 11pt/1.5 body from markdown with h1–h3 scale, bordered light-gray code blocks, styled tables; page numbers via `printToPDF` `footerTemplate`.
- Saved under `reports/` in user data; path stored on the Run; "Show in folder" in the UI.

### 4.8 Desktop App UI

Renderer: React + TypeScript + Vite (`electron-vite`).

1. **Spaces (home)** — card list with draft/published badges; New Space.
2. **Space builder** — name/description; strategy picker with one-line explanations; default model dropdown (live, refreshable); max rounds; MCP checklist; agent list (add/edit/reorder; name, role, system prompt, model override, orchestrator toggle). Publish validates + locks; published view is read-only with "Unpublish to edit".
3. **Run view** — problem input; live feed grouped by round; collapsed-expandable tool calls; streaming tokens; Stop button; completion panel with Open PDF / Show in folder.
4. **Run history** — past runs per Space; transcript replay from `run_events`.
5. **Settings** — LM Studio URL + Test connection; concurrency cap; reports folder; MCP registry management.

**Tiered UX**: default path = pick strategy, add agents with name + role (system prompts auto-generated from role templates), publish. Advanced sections expose full prompt/model/settings control.

### 4.9 Error Handling & Edge Cases

| Condition | Behavior |
|-----------|----------|
| Missing model at preflight | Fail fast, halt entire run, name model + agent |
| LM Studio unreachable mid-run | Run fails with guidance; partial transcript preserved |
| MCP server fails to start | Fail fast at preflight |
| Tool call fails mid-run | Non-fatal; error returned to agent |
| App crash/quit mid-run | On relaunch, `running` runs marked failed ("interrupted"); transcript intact |
| Never-converging agents | Max-round cap + synthesis pass guarantees output |
| Malformed tool-call JSON | One retry nudge, then treated as plain text turn |
| Empty problem text | Blocked in UI |
| Deleting MCP server referenced by published Spaces | Blocked, lists affected Spaces |
| Deleting a Space | Confirmation, then cascades runs/events |
| Second run on a busy Space | Blocked — one active run per Space |

### 4.10 Testing Strategy

- **Unit (Vitest, @acs/core)**: strategies against a fake LLM client (scripted responses) + fake MCP manager — verify round flow, completion signals, max-round synthesis, fail-fast paths deterministically.
- **Integration**: real SQLite (temp file), migration runner, repository layer.
- **E2E smoke (Playwright + Electron)**: create space → publish → run against a mock LM Studio server → PDF exists.

---

## 5. Open Items for Implementation Planning

- ~~Role-template storage~~ — **Resolved (Decision #20)**: static `roles.json` in `@acs/core`, copy-on-create into `agents.system_prompt`; exact roster of starter roles (Researcher, Analyst, Writer, Coder, Reviewer, Critic, Planner, Domain Expert) finalized during Phase 6.2.
- ~~Exact structured completion-signal format~~ — **Resolved (Decision #19)**: tag-delimited plain text (`<final_answer>…</final_answer>`); all structured agent outputs use tags, never JSON.
- ~~Report HTML/CSS design~~ — **Resolved (Decision #23)**: visual spec locked in §4.7 / Phase 7.
