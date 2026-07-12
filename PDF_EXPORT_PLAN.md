# PDF Report Export — Design & Implementation Plan

**Companion to**: [DESIGN.md](DESIGN.md) §4.7 (visual spec) and [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) Phase 7. This is the detailed, validated fill-in of that phase, extended for presets/webhooks and the content decisions from the format brainstorm.

---

## Understanding Summary

- **What**: Automatically generate a PDF report when a run reaches any terminal state (completed, stopped, **or failed**), using the locked visual spec (A4, inline CSS, system fonts, light theme, dark-slate accent).
- **Why**: Plumbing has existed since Phase 5/6 (`run.pdfPath`, `Settings.reportsFolder`) but was never wired; the Run screen shows a "not available yet" placeholder.
- **Where**: Run screen only for now (History deferred). "Open PDF" uses the OS default viewer (`shell.openPath`); "Show in folder" reveals it.
- **Generation model**: automatic, once, immutable. PDF write failure never fails the run (answer/error already persisted).
- **Architecture**: `ReportRenderer` in `@acs/core` (Electron-free, HTML out); `PdfWriter` in `@acs/desktop` (hidden `BrowserWindow` → `printToPDF` → file).
- **Non-goals**: History PDF actions, regeneration, in-app PDF viewing.

## PDF Content & Format (top to bottom)

**Footer on every page**: left `AI Community Solutions`; right `Page X of Y` + run date.

1. **Title** = the Space name (large).
2. **Preset line** (only if `space.presetId`): small `Built from preset: <preset name>` under the title.
3. **Problem block**: the submitted problem, as a quoted block.
4. **Result section** (status-dependent):
   - **Completed** → "Final Answer" heading + `finalAnswer` rendered as markdown. **No status line** (clean).
   - **Failed** → a `Run failed: <error>` box in place of the answer.
   - **Stopped** → a "Stopped early — partial results below" notice in place of the answer.
5. **Full Conversation**: one **labeled card per agent turn**, in chronological (`seq`) order. Each card:
   - **Header**: the agent's **role only** (not its name), with a **Manager** tag when the agent is the orchestrator.
   - **Body**: that agent's full output, rendered as markdown.
   - **Tool calls**: for each, `tool name` + the **exact input/arguments** sent. **No result data.**
   - **System notes** (e.g. synthesis notice) render as small italic lines between cards.

## Assumptions

1. **Turn grouping** derives from existing `RoundStart` events: each `RoundStart` opens a card; every `AgentMessage`/`ToolCall` event until the next `RoundStart` (same run, ascending `seq`) belongs to it. Uniform across all 3 strategies; **no engine change**.
2. **Role + Manager tag** come from the `agents` list (mapped by `agentId` from `RoundStart`); `isOrchestrator` drives the Manager tag.
3. **Tool input** comes from `ToolCall` event `payload.toolCall.function.{name, arguments}`. `ToolResult` events are intentionally **not** rendered.
4. **Markdown**: the app's existing `renderSafeMarkdown` is moved into `@acs/core` and reused, so PDF formatting matches the on-screen final answer exactly. It HTML-escapes first (safe for untrusted model output).
5. **Preset name** looked up via `listSpacePresets()` by `space.presetId`.
6. **Filename**: `<slug(space.name)>-<run.id first 8>-<YYYYMMDD-HHmmss>.pdf` in `Settings.reportsFolder` (default `userData/reports`), created if missing.

## Decision Log

| # | Decision | Alternative | Why |
|---|---|---|---|
| 1 | PDF for every terminal state (completed/stopped/failed) | Completed only | User wants a saved artifact even for partial/failed runs |
| 2 | Title = Space name; problem as a quoted block below | Title = problem | User choice |
| 3 | Order: Final Answer first, then Full Conversation | Conversation first | Reader sees the conclusion first, can dig into the process after |
| 4 | Conversation = labeled cards, header shows **role only** | Show agent name; chat-style; group by round | User choices; "round" isn't uniform across strategies, so chronological turns are the robust unit |
| 5 | Tool calls show name + input only, no results | Full/trimmed results | User choice; also keeps PDFs small |
| 6 | Status shown only when NOT completed | Always show a status line | User choice; completed reports stay clean |
| 7 | Footer carries page numbers + date | No footer / page-only | User choice; date lives here since it's not in the top block |
| 8 | Preset origin line shown when applicable | Never show it | User choice |
| 9 | `renderSafeMarkdown` moves to `@acs/core`, reused by UI + PDF | Duplicate renderer for PDF | One implementation, identical output, no drift |
| 10 | PDF generated in `RunManager` after `engine.start()` resolves | Inside the engine (core) | PDF needs Electron (`printToPDF`); core stays Electron-free |

---

## Implementation

### Part A — Core: markdown move + ReportRenderer

**A1. Move markdown renderer into core.**
- New `packages/core/src/markdown/renderSafeMarkdown.ts` = exact current content of `packages/desktop/src/renderer/src/lib/markdown.ts`.
- Export from `packages/core/src/index.ts`: `export * from './markdown/renderSafeMarkdown.js';`
- `packages/desktop/src/renderer/src/lib/markdown.ts` becomes a one-line re-export: `export { renderSafeMarkdown } from '@acs/core';` (keeps existing renderer imports working; `markdown.test.ts` can stay pointed at this path or move to core — move it to `packages/core/src/markdown/renderSafeMarkdown.test.ts`).

**A2. `packages/core/src/report/ReportRenderer.ts`** — pure, Electron-free:
```ts
import { Run, Space, Agent, RunEvent } from '../domain/types.js';
import { RunStatus, RunEventType } from '../domain/enums.js';
import { renderSafeMarkdown } from '../markdown/renderSafeMarkdown.js';
import { listSpacePresets } from '../presets/spacePresets.js';

export interface RunReportInput {
  run: Run;
  space: Space;
  agents: Agent[];
  events: RunEvent[];   // ascending seq
}

export function renderRunReportHtml(input: RunReportInput): string { /* ... */ }
```
Responsibilities:
- **HTML-escape** all non-markdown text (title, role, problem, tool name/args, error). The problem/error/role are plain text → escape; final answer + agent bodies go through `renderSafeMarkdown` (which escapes internally).
- **Group events into turn-cards** by walking `events` ascending: a `RoundStart` starts a new card (resolve role via `agents.find(a => a.id === ev.agentId)`, Manager tag if `isOrchestrator`, model from `payload.model`); `AgentMessage` appends body markdown; `ToolCall` appends a `{name, arguments}` row (from `payload.toolCall.function`); `System` events flush a standalone italic note; `ToolResult` ignored. Events before any `RoundStart` (rare) go into an unlabeled leading card.
- **Result section** switches on `run.status`: completed → final answer; failed → error box (`run.error`); stopped → notice.
- **Preset line**: `listSpacePresets().find(p => p.id === space.presetId)?.name`.
- Returns a **complete self-contained HTML document** (`<!doctype html><html><head><style>…inline…</style></head><body>…</body></html>`) — A4 `@page` size, system-font stack, dark-slate (`#1e293b`) accent for headings/rules, card borders, quoted-problem style, monospace tool-input style. The footer is NOT in this HTML — it's supplied by Chromium's `footerTemplate` (Part B) so page numbers work.

**A3. Export** `renderRunReportHtml` + `RunReportInput` from `packages/core/src/index.ts`.

### Part B — Desktop main: PdfWriter

**`packages/desktop/src/main/PdfWriter.ts`:**
```ts
import { BrowserWindow } from 'electron';
import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';

export async function writeRunPdf(html: string, outPath: string, footerRight: string): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true });
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const pdf = await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0.5, bottom: 0.7, left: 0.6, right: 0.6 }, // inches; bottom leaves room for footer
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate:
        '<div style="font-size:8px;width:100%;padding:0 12mm;display:flex;justify-content:space-between;color:#64748b;">' +
        '<span>AI Community Solutions</span>' +
        `<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span> · ${escapeHtml(footerRight)}</span>` +
        '</div>'
    });
    await writeFile(outPath, pdf);
  } finally {
    win.destroy();
  }
}
```
(`javascript: false` — the report is static; no scripts needed, tighter sandbox. `footerRight` = the run date string. `escapeHtml` a tiny local helper.)

### Part C — Wiring the trigger (RunManager)

**`packages/core/src/db/repos/RunRepo.ts`** — add:
```ts
public setPdfPath(id: string, pdfPath: string): void {
  this.db.prepare('UPDATE runs SET pdf_path = ? WHERE id = ?').run(pdfPath, id);
}
```

**`packages/desktop/src/main/RunManager.ts`:**
- Constructor gains two injected deps: `private getReportsFolder: () => string` and `private writePdf: (html: string, outPath: string, footerRight: string) => Promise<void>`. (Injecting keeps RunManager unit-testable with a no-op writer; `main/index.ts` passes `() => settingsStore.get().reportsFolder` and `writeRunPdf`.)
- In `startRun`, extend the existing `engine.start().catch(...).finally(...)`: after `this.active.delete(run.id)`, before broadcasting, generate the PDF:
  ```ts
  const finalRun = this.repos.runs.get(run.id);
  if (finalRun) {
    try {
      const space = this.repos.spaces.get(finalRun.spaceId)!;
      const agents = this.repos.agents.listBySpace(finalRun.spaceId);
      const events = this.repos.runEvents.listByRun(finalRun.id);
      const html = renderRunReportHtml({ run: finalRun, space, agents, events });
      const file = join(this.getReportsFolder(), buildPdfFilename(space.name, finalRun));
      await this.writePdf(html, file, new Date(finalRun.finishedAt ?? Date.now()).toLocaleString());
      this.repos.runs.setPdfPath(finalRun.id, file);
    } catch (e) {
      // Log only - a PDF failure must never turn a finished run into a failure.
      console.error('PDF generation failed:', e);
    }
  }
  this.broadcast(RUN_STATUS_PUSH_CHANNEL, this.repos.runs.get(run.id));
  ```
- `buildPdfFilename(spaceName, run)` slugifies the name (`[^a-z0-9]+` → `-`, lowercased, trimmed), appends `run.id.slice(0,8)` and a `YYYYMMDD-HHmmss` stamp, `.pdf`.

**`packages/desktop/src/main/index.ts`** — pass the two new deps into `new RunManager(...)`: `() => settingsStore.get().reportsFolder` and `writeRunPdf` (imported from `./PdfWriter.js`).

### Part D — IPC: open / reveal

**`packages/desktop/src/shared/ipc.ts`** — new schema + channels:
```ts
export const PathSchema = z.object({ path: z.string().min(1) });
// in Channels:
runsOpenPdf: defineChannel('runs:openPdf', PathSchema),
runsShowInFolder: defineChannel('runs:showInFolder', PathSchema),
```
**`packages/desktop/src/main/ipcRouter.ts`** — the router is pure, so inject two callbacks via `IpcRouterDeps`: `openPath: (p: string) => Promise<string>` and `showInFolder: (p: string) => void`. Handlers:
```ts
[Channels.runsOpenPdf.name]: async (p) => {
  const { path } = Channels.runsOpenPdf.requestSchema.parse(p);
  const err = await deps.openPath(path);      // shell.openPath returns '' on success
  if (err) throw new Error(err);
  return undefined;
},
[Channels.runsShowInFolder.name]: async (p) => {
  const { path } = Channels.runsShowInFolder.requestSchema.parse(p);
  deps.showInFolder(path);
  return undefined;
}
```
**`main/index.ts`** provides them from Electron `shell`: `openPath: (p) => shell.openPath(p)`, `showInFolder: (p) => shell.showItemInFolder(p)`.

**`packages/desktop/src/preload/index.ts`** — add to the `runs` API:
```ts
openPdf: (path: string) => invoke<void>(Channels.runsOpenPdf.name, { path }),
showPdfInFolder: (path: string) => invoke<void>(Channels.runsShowInFolder.name, { path })
```

### Part E — Run screen UI

**`packages/desktop/src/renderer/src/screens/RunScreen.tsx`** — replace the current PDF placeholder. Render a PDF action row for **any terminal run with a `pdfPath`** (completed, failed, or stopped), not just completed:
```tsx
{run && run.status !== 'running' && run.pdfPath && (
  <div className="row" style={{ marginTop: 12 }}>
    <button className="btn" onClick={() => call(window.acs.runs.openPdf(run.pdfPath!))}>Open PDF</button>
    <button className="btn" onClick={() => call(window.acs.runs.showPdfInFolder(run.pdfPath!))}>Show in folder</button>
  </div>
)}
```
- The completed block's old "PDF saved to / not available yet" hint is removed (superseded).
- Because the PDF is written in the `finally` *after* the run finishes, the initial `onStatus` broadcast already carries `pdfPath` (the broadcast happens after `setPdfPath`), so the buttons appear as soon as the run resolves. If a completed run is reopened later, `loadLatestRun` already fetches the stored `pdfPath`.

### Part F — Tests

- **`packages/core/src/report/ReportRenderer.test.ts`** (pure, the main coverage): build a Run + Space + agents + a scripted event list, assert the HTML:
  - contains the space name (title) and the problem text;
  - shows the preset line when `presetId` is set, and omits it otherwise;
  - completed → contains the final answer, no status line; failed → contains "Run failed" + the error, not a final-answer heading; stopped → contains the stopped notice;
  - a card header shows the **role**, not the agent name; the orchestrator's card carries the **Manager** tag;
  - a `ToolCall` renders the tool name + its arguments; a `ToolResult` payload does **not** appear;
  - a `System` event renders as a note;
  - output is a single self-contained `<!doctype html>` document with inline `<style>` and no external URLs.
- **`packages/core/src/markdown/renderSafeMarkdown.test.ts`**: moved from desktop, unchanged.
- **`packages/core/src/db/repos.test.ts`**: `setPdfPath` persists and is returned by `get`.
- **`packages/desktop/src/main/RunManager.test.ts`**: after a completed run, the injected `writePdf` is called once and `pdfPath` is set on the run; if the injected `writePdf` **throws**, the run stays completed (PDF failure is swallowed) and status is still broadcast.
- **`packages/desktop/src/main/ipcRouter.test.ts`**: `runs:openPdf` invokes the injected `openPath` and surfaces a non-empty error string as an error envelope; `runs:showInFolder` invokes `showInFolder`.
- **PdfWriter**: no automated test (needs a real Electron `BrowserWindow`); verified manually.

### Manual verification
Run each strategy once; open the PDF; confirm: Space-name title, preset line for a preset Space, problem block, final answer up top, role-headed cards with Manager tag on the orchestrator, tool name+input (no results), footer page numbers + date. Then a **stopped** run and a **failed** run (e.g. point LM Studio at a missing model) produce their notice/error variants with the partial transcript.

### Every file touched or created
| File | Change |
|---|---|
| `packages/core/src/markdown/renderSafeMarkdown.ts` | **New** (moved from desktop) |
| `packages/core/src/markdown/renderSafeMarkdown.test.ts` | **New** (moved) |
| `packages/core/src/report/ReportRenderer.ts` | **New** |
| `packages/core/src/report/ReportRenderer.test.ts` | **New** |
| `packages/core/src/index.ts` | export markdown + ReportRenderer |
| `packages/core/src/db/repos/RunRepo.ts` | `setPdfPath` |
| `packages/core/src/db/repos.test.ts` | `setPdfPath` test |
| `packages/desktop/src/main/PdfWriter.ts` | **New** |
| `packages/desktop/src/main/RunManager.ts` | generate PDF in the post-run finally; 2 new ctor deps |
| `packages/desktop/src/main/RunManager.test.ts` | PDF-generation + failure-swallow tests |
| `packages/desktop/src/main/index.ts` | pass reportsFolder + writeRunPdf + shell deps |
| `packages/desktop/src/main/ipcRouter.ts` | openPdf / showInFolder handlers + deps |
| `packages/desktop/src/main/ipcRouter.test.ts` | open/reveal tests |
| `packages/desktop/src/shared/ipc.ts` | PathSchema + 2 channels |
| `packages/desktop/src/preload/index.ts` | `runs.openPdf` / `showPdfInFolder` |
| `packages/desktop/src/renderer/src/lib/markdown.ts` | re-export from `@acs/core` |
| `packages/desktop/src/renderer/src/screens/RunScreen.tsx` | PDF action buttons for terminal runs |

Not touched: engine strategies, LmStudioClient, McpClient, WebhookClient, presets, SpaceBuilder, History screen, Settings screen.
