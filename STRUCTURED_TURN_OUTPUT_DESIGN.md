# Structured (JSON) Turn Output — Design

**Companion to**: [DESIGN.md](DESIGN.md), [STRUCTURED_STRATEGY_DESIGN.md](STRUCTURED_STRATEGY_DESIGN.md) (unrelated despite the similar name — that's about *who runs when*; this is about *the shape of what each agent returns*).

---

## Understanding Summary

- **What**: every agent turn (every strategy, every preset, every custom Space) requests a JSON-schema-constrained response from the model instead of free text — `{ content: string, keyPoints?: string[] }` — validated, with the plain `content` field transparently unwrapped back into the existing `ChatMessage.content` string before it reaches any downstream consumer (feed, PDF, narrative generator, transcript). Nothing downstream needs to know JSON was involved.
- **Why**: "so we can easily validate and convert or utilize much more efficiently" — a machine-checkable contract per turn (did the model actually answer? are there real key points?) instead of trusting raw prose, and a `keyPoints` array that's genuinely structured data, not something that has to be extracted from prose after the fact.
- **Why now, and why this is safe** (verified empirically, not assumed): tested `response_format: {type: "json_schema", ...}` directly against the user's actual Ollama backend, on `qwen3.5:2b` — **the same model that was returning empty/garbage output under free-text prompting minutes earlier**. It returned a perfectly valid, schema-conforming JSON object. This is *grammar-constrained decoding* — the server restricts which tokens the model is even allowed to sample next, so invalid JSON isn't a "the model chose wrong," it's structurally impossible. This is a fundamentally more reliable mechanism than the tag-delimited approach used for narrative generation (which was a deliberate choice to route *around* local models' unreliable JSON — that reasoning doesn't apply here, because this isn't "ask nicely for JSON," it's "constrain the output to only be JSON").
- **Non-goals**: per-role schemas (Decision: one generic schema, confirmed); showing raw JSON in the feed/PDF (Decision: rendered as prose, confirmed); changing the tag-delimited approach used elsewhere (`<final_answer>`, `<task agent=...>`, narrative `<quote>`) — those stay as-is, this is additive and orthogonal.

## Assumptions

1. The configured backend's OpenAI-compatible endpoint supports `response_format` with `json_schema` (confirmed for Ollama; LM Studio added the same OpenAI-compatible structured-output support in recent versions). If a backend silently ignores the field, the existing empty/malformed-output handling (already hardened this session — retry, then graceful fallback) still catches it; nothing gets *worse*.
2. This applies to **every** `callAgent` call — every strategy (Structured, Orchestrator), every phase kind (sequential, parallel), the framer/synthesizer turns, and `RunOrchestrator.synthesize()`'s salvage call.
3. `ChatMessage.content` remains a plain string everywhere outside `AgentCaller` — zero changes needed in `RunFeed.tsx`, `ReportRenderer.ts`, `NarrativeGenerator.ts`, or any strategy's own logic that reads `msg.content`.

---

## Decision Log

| # | Decision | Alternatives considered | Why |
|---|---|---|---|
| 1 | Use `response_format: json_schema` (grammar-constrained), not prompt-only JSON mode or tag-delimited | Ask nicely in the prompt for JSON; use `<content>...</content>`-style tags like elsewhere in the engine | Empirically proven to work even on the weakest model in the fleet, at the decoding level rather than the model's compliance — categorically more reliable than anything prompt-based |
| 2 | Schema: `{ content: string (required), keyPoints?: string[] }` — one generic shape for every agent | Per-role schemas | Confirmed by user; works uniformly for presets and custom Spaces with zero per-role maintenance |
| 3 | Unwrap transparently inside `AgentCaller` — `ChatMessage.content` becomes the parsed `content` field; `keyPoints` rides along as new, optional data | Change `ChatMessage`'s shape everywhere; have every consumer parse JSON itself | Keeps the blast radius to one file; every existing consumer (feed, PDF, narrative, strategies) keeps working unmodified, since they only ever read `.content` |
| 4 | On invalid/unparseable response: one retry with the schema restated, then fall back to treating the **raw text as `content`** with no `keyPoints` | Fail the turn; fail the run | Matches the established "must never crash the run" rule (same pattern as the tool-call-JSON nudge and the narrative generator's fallback); a degenerate case (backend without schema support) degrades to today's exact behavior, not worse |
| 5 | `keyPoints`, when present, is surfaced as a small bullet list under each turn in the feed and each card in the PDF | Store but never display it | "Utilize much more efficiently" implies it should be visibly useful, not just captured; cheap additive UI change |
| 6 | `RunOrchestrator.synthesize()`'s salvage call also requests structured output (same schema) | Leave the salvage path as free text | Consistency; the salvage path is exactly the situation (a struggling model) where a validated response matters most |
| 7 | Tool-calling turns are exempted — a turn where the model is expected to *return a tool call* (not prose) does not also request `json_schema` in that same request | Request json_schema unconditionally on every request | Most backends' function-calling and forced-JSON-schema modes are mutually exclusive per request (asking a model to both call a tool AND emit a specific JSON body is not a coherent single ask); the JSON-schema request only applies once the model is producing its actual content turn (after any tool-call loop in `callAgent` has resolved to a non-tool-call response) |

---

## Design

### 1. `ChatRequest` — `packages/core/src/llm/types.ts`

```ts
export interface ResponseFormat {
  type: 'json_schema';
  json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  temperature?: number;
  frequency_penalty?: number;
  response_format?: ResponseFormat;   // NEW
}
```

### 2. `LmStudioClient.chat()` — pass it straight through

`chat()` already spreads `...request` into the request body sent to `/chat/completions`, so `response_format` needs **zero** parsing/handling changes there — it's already forwarded. (Verified by reading the current implementation — the body is built as `JSON.stringify({ ...request, stream: true })`.)

### 3. The schema, in one place — `packages/core/src/engine/strategies/AgentCaller.ts`

```ts
const TURN_OUTPUT_SCHEMA = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'agent_turn',
    schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Your full contribution for this turn.' },
        keyPoints: { type: 'array', items: { type: 'string' }, description: 'Optional: 1-5 short highlights of this contribution.' }
      },
      required: ['content']
    },
    strict: true
  }
};

interface ParsedTurn { content: string; keyPoints?: string[] }

function parseTurnOutput(raw: string): ParsedTurn | undefined {
  try {
    const obj = JSON.parse(raw);
    if (typeof obj?.content !== 'string' || !obj.content.trim()) return undefined;
    const keyPoints = Array.isArray(obj.keyPoints) ? obj.keyPoints.filter((k: unknown) => typeof k === 'string') : undefined;
    return { content: obj.content, keyPoints: keyPoints?.length ? keyPoints : undefined };
  } catch {
    return undefined;
  }
}
```

### 4. Wiring into `callAgent`'s tool loop

The tool-call loop already exists; the schema request applies **only to the request that's expected to be the agent's actual turn content**, i.e. every call in the loop — tool-calling and json_schema aren't mutually exclusive to *offer* (a model can still choose to call a tool instead of returning schema-conforming JSON), but once a response comes back **without** `tool_calls`, that's the "real" turn content, and that's what gets schema-validated:

```ts
export async function callAgent(state, agent, messages, roundStartMeta?) {
  const model = agent.modelId || state.space.defaultModel;
  state.onEvent({ type: RunEventType.RoundStart, agentId: agent.id, payload: { model, ...roundStartMeta } });
  const working = [...messages];
  let iterations = 0;

  for (;;) {
    const response = await state.concurrencyLimiter.run(
      () => state.lmStudioClient.chat(
        {
          model, messages: working,
          tools: state.tools.length > 0 ? state.tools : undefined,
          temperature: state.temperature, frequency_penalty: FREQUENCY_PENALTY,
          response_format: TURN_OUTPUT_SCHEMA   // NEW — always requested
        },
        (token) => state.onToken?.(agent.id, token),
        state.signal
      ),
      state.signal
    );

    const msg = response.message;

    if (!msg.tool_calls || msg.tool_calls.length === 0 || iterations >= MAX_TOOL_ITERATIONS) {
      // This is the turn's real content - unwrap it.
      let parsed = parseTurnOutput(msg.content);
      if (!parsed) {
        // One retry: restate the requirement plainly (mirrors the existing
        // malformed-tool-call-JSON nudge pattern).
        const retryMsgs = [...working, msg, {
          role: 'user' as const,
          content: 'Your response was not valid JSON matching the required schema {"content": string, "keyPoints"?: string[]}. Reply again in that exact JSON shape.'
        }];
        const retryResp = await state.concurrencyLimiter.run(
          () => state.lmStudioClient.chat(
            { model, messages: retryMsgs, temperature: state.temperature, frequency_penalty: FREQUENCY_PENALTY, response_format: TURN_OUTPUT_SCHEMA },
            () => {}, state.signal
          ), state.signal
        );
        parsed = parseTurnOutput(retryResp.message.content);
        // Fall back to the raw text if even the retry doesn't parse - never crash the run.
        if (!parsed) parsed = { content: (retryResp.message.content || msg.content).trim() };
      }

      const finalMsg: ChatMessage = { ...msg, content: parsed.content };
      state.onEvent({
        type: RunEventType.AgentMessage,
        agentId: agent.id,
        payload: { message: finalMsg, keyPoints: parsed.keyPoints }   // keyPoints is new, additive
      });
      working.push(finalMsg);
      return finalMsg;
    }

    // ...unchanged tool-call handling below (msg.tool_calls present)...
    working.push(msg);
    for (const tc of msg.tool_calls) { /* unchanged */ }
    iterations++;
  }
}
```

> Note the `AgentMessage` event's `onEvent` call moves from firing unconditionally right after every response to firing only once, on the resolved (non-tool-call) turn — today's code already only pushes ONE `AgentMessage` event per turn (after the tool loop exits), so this is not a behavior change, just where in the function it happens (after unwrapping instead of before).

### 5. `RunOrchestrator.synthesize()` — same schema, same unwrap

```ts
private async synthesize(): Promise<string> {
  const messages: ChatMessage[] = [ /* unchanged */ ];
  const res = await this.state.concurrencyLimiter.run(
    () => this.state.lmStudioClient.chat(
      { model: this.state.space.defaultModel, messages, temperature: this.state.temperature, response_format: TURN_OUTPUT_SCHEMA },
      () => {}, this.abortController.signal
    ), this.abortController.signal
  );
  const parsed = parseTurnOutput(res.message.content);
  if (parsed) return parsed.content.trim();
  // Fallback: today's exact behavior (strip a stray <final_answer> tag if present, else raw text).
  const m = res.message.content.match(/<final_answer>([\s\S]*?)<\/final_answer>/);
  return (m ? m[1] : res.message.content).trim();
}
```

(`TURN_OUTPUT_SCHEMA`/`parseTurnOutput` exported from `AgentCaller.ts` for reuse here.)

### 6. Surfacing `keyPoints` — feed + PDF (additive only)

- `RunFeed.tsx`: `AgentMessage` payload gains optional `keyPoints?: string[]`; when present, render a small bulleted list under the turn's body (same visual treatment as the PDF's existing "Key Points" styling for the final answer, reused here per-turn).
- `ReportRenderer.ts`: same, in the per-turn card (only on the non-narrative/card-based rendering path — the narrative path already produces its own prose and is untouched).
- Both are purely additive: `keyPoints` absent (backend doesn't honor `response_format`, or the model legitimately didn't provide any) → nothing renders, page looks exactly as it does today.

---

## Test Plan

- **`AgentCaller` (`strategies.test.ts` or new `agentCaller.test.ts`)**:
  - `chat` mock returns valid `{"content":"...", "keyPoints":["a","b"]}` → `callAgent`'s returned message has `content` unwrapped correctly; the emitted `AgentMessage` event's payload carries `keyPoints`.
  - `chat` mock returns non-JSON text → one retry request is made (assert `chat` called twice) with a corrective message; if the retry succeeds, that's used.
  - Both attempts return non-JSON → falls back to raw text as `content`, run does not throw, `keyPoints` is undefined.
  - `response_format` is present on every `chat` call for a non-tool-calling turn.
  - Existing tool-call-loop tests (tool call → result → final message) still pass — confirms unwrapping doesn't disturb the loop.
- **`RunOrchestrator.synthesize()`**: valid JSON → unwrapped `content` returned; invalid JSON with a stray `<final_answer>` tag → existing tag-stripping fallback still works (regression guard for the pre-existing behavior).
- **`presetWorkflows.test.ts`**: update the fake model to return valid schema JSON instead of plain text (more realistic now) — confirms no regression across all 7 presets.
- **UI**: manual verification that `keyPoints` render under a turn in the feed and in the PDF when present, and that omitting them (older/incompatible backend) looks identical to before.

## Implementation Order

1. `ChatRequest.response_format` type + confirm `LmStudioClient.chat()` passes it through untouched (should need zero code change there — verify with a quick test asserting the field appears in the request body).
2. `TURN_OUTPUT_SCHEMA` + `parseTurnOutput` + `AgentCaller.callAgent()` wiring, with retry/fallback, and its tests.
3. `RunOrchestrator.synthesize()` wiring + regression test for the tag-fallback path.
4. `presetWorkflows.test.ts` update to the more realistic mock.
5. Feed + PDF `keyPoints` display (additive, no existing test should need to change).
6. Full `npm run verify`, then a manual run against the real Ollama backend confirming `keyPoints` show up and the model that was previously returning empty output now produces real, validated content.

## Acceptance Criteria

- Every agent turn's `chat` request includes `response_format` (verified via a test asserting on the captured request).
- A turn with a genuinely non-JSON-capable backend/model degrades to exactly today's behavior (raw text as content, no crash).
- `keyPoints`, when the model provides them, are visible in both the feed and the PDF.
- Re-running the exact failing scenario from this session (Six Hats on `qwen3.5:2b`/`ornith:9b`) — since grammar-constrained decoding is categorically different from free-text prompting, this should measurably reduce (not necessarily eliminate) the "returned no contribution" empty-output problem, since the model is now structurally guided toward producing *something* in the `content` field rather than being free to output nothing.
- `npm run verify` green; no changes required in `RunFeed.tsx`/`ReportRenderer.ts`/`NarrativeGenerator.ts` beyond the additive `keyPoints` display.
