import { ChatRequest, ChatResponse, ChatMessage, ToolCall } from './types.js';

export interface StallConfig {
  firstTokenTimeoutMs?: number;
  interTokenTimeoutMs?: number;
  overallTimeoutMs?: number;
}

const DEFAULT_STALL_CONFIG: StallConfig = {
  firstTokenTimeoutMs: 120_000,
  interTokenTimeoutMs: 60_000,
  overallTimeoutMs: 600_000
};

export class LmStudioClient {
  constructor(private baseUrl: string = 'http://localhost:1234/v1') {}

  public async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/models`);
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
    let response: Response;
    const timeouts = { ...DEFAULT_STALL_CONFIG, ...stallConfig };

    try {
      const abortController = new AbortController();
      const onSignalAbort = () => abortController.abort();
      if (signal) signal.addEventListener('abort', onSignalAbort);

      let stallTimer: NodeJS.Timeout | null = null;
      let overallTimer: NodeJS.Timeout | null = null;

      const resetStallTimer = (ms: number) => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          abortController.abort(new Error('Model stall timeout: no tokens received for ' + ms + 'ms. Model may be overloaded.'));
        }, ms);
      };

      if (timeouts.overallTimeoutMs) {
        overallTimer = setTimeout(() => {
          abortController.abort(new Error('Model overall timeout exceeded (' + timeouts.overallTimeoutMs + 'ms)'));
        }, timeouts.overallTimeoutMs);
      }

      resetStallTimer(timeouts.firstTokenTimeoutMs!);

      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...request, stream: true }),
        signal: abortController.signal
      });

      if (!response.ok) {
        if (stallTimer) clearTimeout(stallTimer);
        if (overallTimer) clearTimeout(overallTimer);
        throw new Error(`HTTP Error ${response.status}: ${await response.text()}`);
      }

      if (!response.body) {
        throw new Error('No response body returned from LM Studio');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      
      let finalContent = '';
      let currentToolCalls: ToolCall[] | undefined = undefined;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        resetStallTimer(timeouts.interTokenTimeoutMs!);
        const chunk = decoder.decode(value, { stream: true });
        
        const lines = chunk.split('\n').filter(l => l.trim() !== '');
        for (const line of lines) {
          if (line === 'data: [DONE]') continue;
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              const delta = data.choices[0]?.delta;
              if (!delta) continue;

              if (delta.content) {
                finalContent += delta.content;
                onToken(delta.content);
              }

              if (delta.tool_calls) {
                if (!currentToolCalls) currentToolCalls = [];
                for (const tcDelta of delta.tool_calls) {
                  const idx = tcDelta.index;
                  if (!currentToolCalls[idx]) {
                    currentToolCalls[idx] = {
                      id: tcDelta.id || '',
                      type: 'function',
                      function: { name: tcDelta.function?.name || '', arguments: tcDelta.function?.arguments || '' }
                    };
                  } else {
                    if (tcDelta.function?.arguments) {
                      currentToolCalls[idx].function.arguments += tcDelta.function.arguments;
                    }
                  }
                }
              }
            } catch {
              // Ignore parse errors on partial lines, wait for next chunk
            }
          }
        }
      }

      if (stallTimer) clearTimeout(stallTimer);
      if (overallTimer) clearTimeout(overallTimer);
      if (signal) signal.removeEventListener('abort', onSignalAbort);

      const msg: ChatMessage = {
        role: 'assistant',
        content: finalContent,
      };

      if (currentToolCalls && currentToolCalls.length > 0) {
        msg.tool_calls = currentToolCalls;
      }

      return { message: msg };
    } catch (e: unknown) {
      if (e instanceof Error) {
        if (e.name === 'AbortError' || e.message?.includes('stall') || e.message?.includes('timeout')) {
          throw new Error(e.message || 'Request aborted or timed out.');
        }
        if (e.name === 'TypeError' || e.message.includes('fetch')) {
          throw new Error('Is LM Studio running? Failed to connect to ' + this.baseUrl);
        }
      }
      throw e;
    }
  }
}
