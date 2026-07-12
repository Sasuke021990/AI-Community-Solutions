# Phase 6 UI Polish — Design & Implementation Plan

**Companion to**: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) Phase 6, which marks these three items as not yet done:
1. Token-level streaming (no live typing effect — the feed only shows a whole `AgentMessage` once a turn finishes)
2. Auto-scroll with pause-on-manual-scroll for the run feed
3. Stop button has no confirmation dialog

(The fourth Phase 6 gap noted during verification — feed grouped chronologically by `seq` instead of by round — is a **documented deviation**, not a bug: "round" isn't a uniform concept across all three strategies, so chronological turns are the robust unit. Out of scope here.)

---

## Understanding Summary

- **What**: three independent UI-polish improvements to `RunScreen.tsx`/`RunFeed.tsx` — live token streaming, scroll behavior, and a stop-confirmation step.
- **Why**: these were always deferred to "later" in the original phase plan; nothing is broken today, this is refinement, not a bug fix.
- **Where**: almost entirely `packages/desktop/src/renderer`. Streaming is the only one that reaches into `@acs/core` (engine) and the IPC bridge.
- **Non-goals**: grouped-by-round feed layout (documented deviation, not in scope), a general-purpose modal/dialog component (reusing the existing inline-banner confirm pattern instead), persisting streamed tokens to SQLite or the PDF report (the final `AgentMessage` event already carries the complete text — tokens are a live-only visual).

## Key existing-code finding that shapes the streaming design

`LmStudioClient.chat()` (`packages/core/src/llm/LmStudioClient.ts`) **already** parses the SSE stream and invokes an `onToken(token: string)` callback per delta — this is real, working code, already covered by tests (`llm.test.ts`: SSE chunk-splitting, tool-call assembly across chunks, etc.). The only reason no token ever reaches the UI today is that `AgentCaller.callAgent()` (`packages/core/src/engine/strategies/AgentCaller.ts:71`) passes a no-op:

```ts
() => {},   // <- onToken, currently discarded
```

So this feature is **plumbing**, not new streaming logic: thread the callback that already exists through the engine, an IPC push channel, and into the feed component.

---

## Feature 1 — Stop confirmation

### Design

Reuse the exact pattern already proven in `SpaceBuilderScreen.tsx`'s Publish flow (`confirmPublish` state + `useRef`-focused confirm button in an inline `banner-info`) — this is the pattern whose focus bug was fixed earlier this session, so it's both consistent with the app's look and already debugged. No `window.confirm()`, no new Modal component (unnecessary abstraction for a single use site).

### Changes — `packages/desktop/src/renderer/src/screens/RunScreen.tsx`

- Add state: `const [confirmStop, setConfirmStop] = useState(false);` and `const confirmStopBtnRef = useRef<HTMLButtonElement>(null);`
- `useEffect(() => { if (confirmStop) confirmStopBtnRef.current?.focus(); }, [confirmStop]);`
- Stop button (`onClick={stop}`) becomes `onClick={() => setConfirmStop(true)}`.
- New inline banner, shown when `confirmStop` is true, styled like the publish-confirm banner:
  > "Stop this run? Progress so far will be saved as a stopped run."
  > `[Confirm stop]` (ref-focused, calls the real `stop()`, then `setConfirmStop(false)`) `[Cancel]` (`setConfirmStop(false)`)
- `newRun()` and the `spaceId` effect's reset both also reset `confirmStop = false`, matching how `confirmPublish` resets on space/run changes.

### Edge cases

- If the run finishes on its own (completes/fails) while the confirm banner is showing, the banner must disappear — it's already gated on `isRunning`/`run` being in the running state via the same conditional that currently renders the Stop button, so this falls out naturally.
- Rapid double-click on "Confirm stop": disable it while `stopping` is true, same as today's Stop button already does.

### Test plan

Component-level (renderer has no existing test infra beyond types — confirmed no `*.test.tsx` files exist in `packages/desktop/src/renderer`). This is consistent with the rest of the app: renderer screens are verified manually in the browser/Electron, not unit-tested. No new test framework introduced for one small state addition; verified manually per the acceptance criteria below.

---

## Feature 2 — Auto-scroll with pause-on-manual-scroll

### Design

Contained entirely to the feed's scroll container. Determine "user is at the bottom" **idempotently** on every scroll event via `scrollHeight - scrollTop - clientHeight < threshold` (~40px), rather than tracking "did I cause this scroll" — this way a scroll we just performed programmatically still measures as "at bottom" (auto-scroll stays on), and only a genuine manual scroll upward measures as "away from bottom" (auto-scroll turns off). No flag-juggling between programmatic and user-driven scrolls needed.

### Changes — `packages/desktop/src/renderer/src/components/RunFeed.tsx` (or a thin wrapper in `RunScreen.tsx` — see open question below)

- Wrap the feed's rendered list in a container with a ref (`feedRef`).
- State: `const [autoScroll, setAutoScroll] = useState(true);`
- `onScroll` handler on the container: compute the at-bottom check above; `setAutoScroll(atBottom)`.
- `useEffect` keyed on the feed's content changing (event count + any streaming text from Feature 3) that, when `autoScroll` is true, sets `feedRef.current.scrollTop = feedRef.current.scrollHeight`.
- When `autoScroll` is false, render a small floating "↓ Jump to latest" button anchored to the bottom of the feed container; `onClick` scrolls to bottom and sets `autoScroll = true`.
- Reset `autoScroll = true` when `spaceId` changes (same effect in `RunScreen.tsx` that already resets `events`/`seenEventIds`) and when `newRun()` is called.

### Resolved: fixed-height feed panel

Confirmed — the feed gets its own bounded, independently-scrolling panel (chat-app feel) rather than scrolling with the whole page. Implementation: `max-height: min(65vh, 680px); overflow-y: auto;` on the feed's container, so it's the feed that scrolls internally while the header, status row, and (once the run finishes) the final-answer/PDF-buttons block stay outside it and always visible. This is deliberately a bounded `max-height`, not a `flex:1` fill-remaining-space layout — it doesn't require touching `.main`'s shared scroll behavior (used by every other screen), so the diff stays isolated to `RunFeed.tsx`/its wrapper. See the Visual Design Spec below for exact CSS.

### Edge cases

- Empty feed (`items.length === 0`, the existing early return) — no scroll container needed yet, `autoScroll` stays at its default `true` for whenever content starts arriving.
- Very fast token streaming (Feature 3) firing the scroll-adjustment effect too often — mitigated for free by Feature 3's own throttling of state updates (see below), since the effect is keyed on that already-throttled state.
- Fixed-height panel means the feed can show its own internal scrollbar even on a short run — verify the empty/near-empty state doesn't look awkward with a mostly-empty bordered box (it already has `.empty-state` centered styling for the zero-items case, reused as-is).

### Test plan

Manual verification only, same rationale as Feature 1 (no renderer test infra exists).

---

## Feature 3 — Token-level streaming

### Architecture: a second, ephemeral event channel parallel to the persisted one

The existing `RunOrchestrator.onEvent(cb)` / `EngineEvent` path persists every event to SQLite before broadcasting it — correct for the transcript (source of truth) but wrong for tokens: a typical turn might stream hundreds of small deltas, and the final `AgentMessage` event already captures the complete assembled text. Persisting tokens would bloat the run-events table and (if not carefully excluded) the PDF report for zero information gain. So tokens get their **own** subscribe method and IPC channel that is explicitly never written to `RunEventRepo`.

### Changes by layer

**`packages/core/src/engine/strategies/AgentStrategy.ts`** (`ExecutionState` interface):
```ts
onToken?: (agentId: string, token: string) => void;
```

**`packages/core/src/engine/strategies/AgentCaller.ts:71`**:
```ts
// before: () => {},
(token) => state.onToken?.(agent.id, token),
```

**`packages/core/src/engine/RunOrchestrator.ts`**:
- New private `private tokenListeners = new Set<(agentId: string, token: string) => void>();`
- New public method, mirroring the existing `onEvent`:
  ```ts
  public onToken(cb: (agentId: string, token: string) => void): () => void {
    this.tokenListeners.add(cb);
    return () => this.tokenListeners.delete(cb);
  }
  ```
- In the `state` object construction, add:
  ```ts
  onToken: (agentId, token) => {
    for (const cb of this.tokenListeners) {
      try { cb(agentId, token); } catch { /* a subscriber error must not break the run */ }
    }
  }
  ```
  (mirrors the existing try/catch-per-listener robustness already used for `onEvent`)

**`packages/desktop/src/shared/ipc.ts`**: new constant
```ts
export const RUN_TOKEN_PUSH_CHANNEL = 'runs:token';
```

**`packages/desktop/src/main/RunManager.ts`** (`startRun`, right next to the existing `engine.onEvent(...)` line):
```ts
engine.onToken((agentId, token) => this.broadcast(RUN_TOKEN_PUSH_CHANNEL, { runId: run.id, agentId, token }));
```

**`packages/desktop/src/preload/index.ts`**: new subscription, alongside `onEvent`/`onStatus`:
```ts
onToken: (cb: (p: { runId: string; agentId: string; token: string }) => void) =>
  subscribe<{ runId: string; agentId: string; token: string }>(RUN_TOKEN_PUSH_CHANNEL, cb),
```

**`packages/desktop/src/renderer/src/screens/RunScreen.tsx`**:
- New ref: `const streamingRef = useRef(new Map<string, string>());` (raw accumulator, not state — avoids a re-render per token)
- New state: `const [streamingVersion, setStreamingVersion] = useState(0);` bumped on a throttled flush (see below) so React re-renders without putting the hot-path map itself in state.
- Subscribe in the existing `useEffect` that wires `onEvent`/`onStatus`:
  ```ts
  const unsubToken = window.acs.runs.onToken(({ runId, agentId, token }) => {
    if (runId !== runIdRef.current) return;
    const cur = streamingRef.current.get(agentId) ?? '';
    streamingRef.current.set(agentId, cur + token);
    scheduleFlush(); // throttled — see Edge cases
  });
  ```
- When `addEvent` receives an `AgentMessage` for an agent, clear that agent's entry from `streamingRef.current` (the persisted final text now takes over — prevents the streamed partial from lingering underneath/duplicating the final render).
- Pass a derived `streamingByAgent` (built from `streamingRef.current`, recomputed only when `streamingVersion` changes) down to `<RunFeed>`.

**`packages/desktop/src/renderer/src/components/RunFeed.tsx`**:
- New optional prop: `streamingByAgent?: Map<string, string>`.
- In the turn-rendering branch: when `live && !item.turn!.message`, check `streamingByAgent?.get(item.turn!.agentId)`; if present, render it (through the same `renderSafeMarkdown`) with a trailing blinking-cursor `<span className="typing-cursor" />` instead of the current static `"thinking"` dots. If absent, keep today's `"thinking"` dots (covers the gap between round-start and the first token arriving).

### Edge cases (explicit)

1. **Throttling** — tokens can arrive many times per second from a fast local model. Flushing React state on every single token would cause visible jank. `scheduleFlush()` batches: if a flush isn't already pending, schedule one via `setTimeout(..., 50)` (or `requestAnimationFrame`), then bump `streamingVersion` once. Multiple tokens arriving within that window collapse into a single re-render. This lives entirely in the renderer — no timing complexity added to the engine, which is important because the engine is tested with Vitest fake timers (`llm.test.ts`'s stall-timeout tests) and any new timer there would need careful fake-timer interaction.
2. **Stale-run filtering** — reuses the exact `runId !== runIdRef.current` guard the existing `onEvent`/`onStatus` subscriptions already use; no new mechanism.
3. **Clearing on turn completion** — must clear `streamingRef.current`'s entry for an agent the moment its real `AgentMessage` event lands, or the reader would briefly see the streamed partial text and the final persisted text stacked/duplicated.
4. **Page reload / reopening a Space mid-run** (`loadLatestRun` path) — no historical replay of tokens is possible or needed; the persisted events already replay the full transcript. A user who reloads mid-turn simply sees "thinking" until the next token or the turn's completion — acceptable, matches how a page refresh loses any other client-only UI state.
5. **Multiple agents streaming concurrently** (Orchestrator/RoundRobin strategies can have concurrent in-flight calls per `engine.test.ts`'s "aborts other in-flight concurrent calls" test) — the `Map<agentId, string>` keys by agent, so concurrent streams don't collide; each turn card looks up only its own agent's entry.

### Test plan

- **Core** (`packages/core/src/engine/strategies/strategies.test.ts` or `engine.test.ts`): a test giving a fake `lmStudioClient.chat` that invokes its `onToken` callback with a few chunks before resolving, asserting `state.onToken` (captured via a spy passed through `ExecutionState`) is called once per chunk with the correct `agentId` and that omitting `onToken` entirely doesn't throw (optional-chaining safety).
- **Desktop** (`packages/desktop/src/main/RunManager.test.ts`): update the `chat` mock to call its token callback before resolving; assert `broadcasts` contains `RUN_TOKEN_PUSH_CHANNEL` entries with the right shape.
- **Renderer**: manual verification only (no test infra), per the acceptance criteria below.

---

---

## Visual Design Spec

Goal: make these three additions look like a deliberate, polished part of the app — not bolted-on — by extending the existing dark developer-tool theme (`packages/desktop/src/renderer/src/styles.css`: near-black `--bg: #0f1115`, elevated panels `--bg-elevated: #171a21`, accent blue `--accent: #5b8def`, 6px radius, system font stack) rather than introducing a new palette. All additions below are new rules appended to that same stylesheet, reusing existing CSS variables.

*Grounded in the `ui-ux-pro-max` skill's guideline data (`ux-guidelines.csv`) — its CLI script hit a Python-version syntax error in this environment (f-string with a backslash, needs Python 3.12+, this machine has 3.11), so I read the underlying guideline rows directly instead of running the broken script.*

**1. Fixed-height feed panel**
```css
.run-feed-panel {
  position: relative;
  max-height: min(65vh, 680px);
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  padding: 12px;
}
```
The existing `.feed` (flex column, 10px gap) nests inside this unchanged.

**2. "Jump to latest" button** — `position: sticky` inside the scroll panel avoids any manual scroll-position math (matches the guideline data's sticky-element pattern, `ux-guidelines.csv` row 2):
```css
.jump-latest {
  position: sticky;
  bottom: 10px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  border: none;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(91, 141, 239, 0.35);
  transition: transform 150ms ease, filter 150ms ease;
}
.jump-latest:hover { filter: brightness(1.1); }
.jump-latest:active { transform: translateX(-50%) translateY(1px); }
```
150ms transition matches the skill's micro-interaction timing guidance (150–300ms).

**3. Typing cursor** (streamed, in-progress agent text) — shape-based (a blinking bar), not color-only, per the "don't convey state by color alone" guideline (`ux-guidelines.csv` row 37):
```css
.typing-cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  background: var(--accent);
  margin-left: 2px;
  vertical-align: text-bottom;
  animation: blink 1s step-start infinite;
}
@keyframes blink { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .typing-cursor { animation: none; opacity: 0.6; }
}
```
Respecting `prefers-reduced-motion` directly follows the guideline data's High-priority "Motion Sensitivity" rule (`ux-guidelines.csv` row 100).

**4. Active-turn highlight** — while an agent's turn is actively streaming, its card gets a subtle accent border + glow so the eye finds the live agent immediately in a busy multi-agent feed (again shape/border-based, not color-alone):
```css
.feed-turn.is-streaming {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent-dim);
}
```
Applied in `RunFeed.tsx` when `live && streamingByAgent?.has(agentId) && !turn.message`.

**5. Animated "thinking" state** — replace the current static `...` with a subtle pulse so the feed feels alive before the first token arrives, without being distracting (guideline data explicitly warns against decorative infinite animation but endorses it for loading indicators — `ux-guidelines.csv` row 12):
```css
.loading-dots::after {
  content: '...';
  animation: pulse-dots 1.2s ease-in-out infinite;
}
@keyframes pulse-dots { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .loading-dots::after { animation: none; }
}
```

**6. Stop-confirm banner tone** — the existing `.banner-info` (blue) is reused by Publish-confirm; a distinct **warning-toned** variant better signals "this pauses an active run" (semantically closer to caution than neutral info), using the already-defined `--warning` variable:
```css
.banner-warning {
  background: rgba(217, 164, 65, 0.1);
  border: 1px solid rgba(217, 164, 65, 0.4);
  color: #f0c775;
}
```

**7. Visible focus rings (accessibility gap found while reading the stylesheet)** — the current CSS has no `:focus` styling anywhere, which fails the guideline data's High-priority "Focus States" rule (`ux-guidelines.csv` row 28: keyboard users need visible focus indicators). Adding this benefits the new auto-focused Confirm/Cancel/Jump-to-latest buttons specifically, and every existing interactive element for free:
```css
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

**Token streaming validated against the guideline data**: row 94 of `ux-guidelines.csv` explicitly lists "Stream text response token by token" as the recommended pattern over "Show loading spinner for 10s+", which is exactly Feature 3's premise.

---

## Decision Log

| # | Decision | Alternative | Why |
|---|---|---|---|
| 1 | Tokens get a separate, non-persisted event channel (`onToken`/`RUN_TOKEN_PUSH_CHANNEL`) | Persist tokens as `RunEvent`s like everything else | Tokens are high-frequency and redundant with the final `AgentMessage`; persisting would bloat SQLite and the PDF export for no value |
| 2 | Renderer-side throttling (batched flush) for token UI updates | Throttle in the engine/main process | Keeps the engine's timing simple and fake-timer-test-friendly; UI jank is a UI concern |
| 3 | Stop confirmation reuses the existing inline-banner + focused-button pattern from Publish | `window.confirm()` or a new Modal component | Already proven, already debugged (focus bug fixed earlier this session), visually consistent, no new abstraction |
| 4 | Auto-scroll "at bottom" check is idempotent (`scrollHeight - scrollTop - clientHeight < threshold`) | Track a "we just scrolled programmatically" flag | Simpler, no flag-synchronization bugs, self-correcting |
| 5 | No renderer unit tests added for these changes | Add a renderer test framework | Consistent with the rest of the app — renderer screens are verified manually; introducing test infra for 3 small UI changes is out of proportion |
| 6 | Feed is a bounded `max-height` panel (`min(65vh, 680px)`), not a `flex:1` fill-remaining-space layout | Restructure `.main`'s shared scroll behavior so only the feed scrolls | Confirmed by you: fixed-height feed panel. Bounded max-height gets the same chat-app feel without touching layout shared by every other screen |
| 7 | New CSS extends the existing dark theme's variables (`--accent`, `--warning`, `--bg`, etc.) | Introduce a new palette/design language for just these components | Requested UI should "suit my work" — visual consistency with the app's established look matters more than novelty; also avoids clashing with 470+ lines of existing styling |
| 8 | Added `:focus-visible` global outline and `prefers-reduced-motion` handling on all new animations | Ship without them | Both are High-priority rules in the UI/UX skill's guideline data that the current stylesheet doesn't cover at all; low-cost, meaningfully improves accessibility |
| 9 | New `.banner-warning` variant (amber) for the stop-confirm banner, distinct from Publish's `.banner-info` (blue) | Reuse `.banner-info` for both | Stopping an active run is semantically a caution, not neutral information; a distinct tone plus the existing text makes the state clearer without relying on color alone |

## Assumptions

1. The "Jump to latest" button, typing-cursor, active-turn highlight, and pulse animation are simple CSS additions to the existing stylesheet, not new dependencies or icon libraries.
2. Concurrent per-agent streaming (Orchestrator/RoundRobin) is handled correctly by keying the streaming map on `agentId`, consistent with how persisted events are already keyed.
3. The UI/UX skill's CLI (`search.py`) could not run in this environment (Python 3.11 vs. the script's Python-3.12-only f-string syntax) — recommendations above come from reading its underlying CSV guideline data directly, not a generated design-system report. If you want the full generated report, upgrading Python (or patching that one line in the skill script) would unblock it, but wasn't necessary to produce this plan.

## Implementation order

1. **Stop confirmation** — smallest, zero cross-layer risk, isolated to one screen.
2. **Auto-scroll** — frontend-only, independent of streaming.
3. **Token streaming** — the only one touching core/IPC/preload; built last so it can be verified against auto-scroll (#2) already being in place.

Each step gets its own `npm run verify` pass and a relaunch of the app for your manual testing before moving to the next — same discipline as every other feature this session.

## Acceptance criteria

- Clicking Stop shows the inline amber-toned confirm banner; Cancel dismisses it without stopping; Confirm stop actually stops the run and the banner disappears.
- The feed renders as a bordered, fixed-height panel (not full-page scroll) that auto-scrolls to follow new content; scrolling up pauses auto-follow and reveals the "Jump to latest" pill; scrolling back to the bottom (or clicking it) resumes auto-follow.
- During a run, agent responses appear character-by-character with a visible blinking cursor as the model generates them, not only once the full message is complete; the actively-streaming turn's card is visibly highlighted; the final rendered text after completion is identical to today's (no drift between streamed and persisted content).
- Tab-key navigation shows a visible focus ring on every interactive element, including the new Confirm/Cancel/Jump-to-latest buttons.
- All new animations (cursor blink, thinking pulse) stop/dim under `prefers-reduced-motion: reduce`.
- `npm run verify` passes (lint, typecheck, build, all tests) after each step.
