import { ChatRequest, ChatResponse, ChatMessage, ToolCall } from './types.js';

export interface StallConfig {
  firstTokenTimeoutMs?: number;
  interTokenTimeoutMs?: number;
  overallTimeoutMs?: number;
}

const DEFAULT_STALL_CONFIG: Required<StallConfig> = {
  firstTokenTimeoutMs: 120_000,
  interTokenTimeoutMs: 60_000,
  overallTimeoutMs: 600_000
};

export class LmStudioClient {
  constructor(private baseUrl: string = 'http://localhost:1234/v1') {}

  public async listModels(signal?: AbortSignal): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, { signal });
      if (!response.ok) {
        throw new Error(`HTTP Error ${response.status}: ${await response.text()}`);
      }
      const data = await response.json();
      return (data.data || []).map((m: { id: string }) => m.id);
    } catch (e: unknown) {
      if (e instanceof Error && (e.name === 'TypeError' || e.message.includes('fetch'))) {
        throw new Error('Is LM Studio running? Failed to connect to ' + this.baseUrl);
      }
      throw e;
    }
  }

  public async chat(
    request: ChatRequest,
    onToken: (token: string) => void,
    signal?: AbortSignal,
    stallConfig: StallConfig = DEFAULT_STALL_CONFIG
  ): Promise<ChatResponse> {
    const timeouts = { ...DEFAULT_STALL_CONFIG, ...stallConfig };

    const abortController = new AbortController();
    const onSignalAbort = () => abortController.abort();
    if (signal) {
      if (signal.aborted) abortController.abort();
      else signal.addEventListener('abort', onSignalAbort);
    }

    // Declared outside try so the finally block can always clear them.
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    let overallTimer: ReturnType<typeof setTimeout> | null = null;

    const resetStallTimer = (ms: number) => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        abortController.abort(
          new Error(`Model stall timeout: no tokens received for ${ms}ms. Model may be overloaded.`)
        );
      }, ms);
    };

    try {
      overallTimer = setTimeout(() => {
        abortController.abort(new Error(`Model overall timeout exceeded (${timeouts.overallTimeoutMs}ms)`));
      }, timeouts.overallTimeoutMs);

      resetStallTimer(timeouts.firstTokenTimeoutMs);

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...request, stream: true }),
        signal: abortController.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP Error ${response.status}: ${await response.text()}`);
      }
      if (!response.body) {
        throw new Error('No response body returned from LM Studio');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');

      let finalContent = '';
      const currentToolCalls: ToolCall[] = [];
      // Buffer holds any partial trailing line between reads, since chunk
      // boundaries do not align with SSE line boundaries.
      let buffer = '';

      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (trimmed === '' || !trimmed.startsWith('data:')) return;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') return;

        let data;
        try {
          data = JSON.parse(payload);
        } catch {
          // A genuinely malformed *complete* line; skip it.
          return;
        }

        const delta = data.choices?.[0]?.delta;
        if (!delta) return;

        if (delta.content) {
          finalContent += delta.content;
          onToken(delta.content);
        }

        if (delta.tool_calls) {
          for (const tcDelta of delta.tool_calls) {
            const idx = tcDelta.index ?? 0;
            if (!currentToolCalls[idx]) {
              currentToolCalls[idx] = {
                id: tcDelta.id || '',
                type: 'function',
                function: {
                  name: tcDelta.function?.name || '',
                  arguments: tcDelta.function?.arguments || ''
                }
              };
            } else {
              if (tcDelta.id && !currentToolCalls[idx].id) currentToolCalls[idx].id = tcDelta.id;
              if (tcDelta.function?.name) currentToolCalls[idx].function.name += tcDelta.function.name;
              if (tcDelta.function?.arguments) currentToolCalls[idx].function.arguments += tcDelta.function.arguments;
            }
          }
        }
      };

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        resetStallTimer(timeouts.interTokenTimeoutMs);

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // Keep the last (possibly incomplete) line for the next chunk.
        buffer = lines.pop() ?? '';
        for (const line of lines) processLine(line);
      }

      // Flush any decoder + buffer remainder as a final complete line.
      buffer += decoder.decode();
      if (buffer.trim() !== '') processLine(buffer);

      const msg: ChatMessage = { role: 'assistant', content: finalContent };
      if (currentToolCalls.length > 0) {
        msg.tool_calls = currentToolCalls;
      }
      return { message: msg };
    } catch (e: unknown) {
      // If we aborted with a reason (stall / overall timeout, or user abort
      // carrying an Error), surface that reason's message.
      const reason = abortController.signal.reason;
      if (reason instanceof Error && (reason.message.includes('stall') || reason.message.includes('timeout'))) {
        throw reason;
      }
      if (e instanceof Error) {
        if (e.name === 'AbortError') {
          throw new Error('Request aborted.');
        }
        if (e.name === 'TypeError' || e.message.includes('fetch')) {
          throw new Error('Is LM Studio running? Failed to connect to ' + this.baseUrl);
        }
      }
      throw e;
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
      if (overallTimer) clearTimeout(overallTimer);
      if (signal) signal.removeEventListener('abort', onSignalAbort);
    }
  }
}
