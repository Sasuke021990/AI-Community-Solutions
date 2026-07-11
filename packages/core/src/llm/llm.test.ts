import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LmStudioClient } from './LmStudioClient.js';
import { ConcurrencyLimiter } from './ConcurrencyLimiter.js';

describe('ConcurrencyLimiter', () => {
  it('limits concurrent executions', async () => {
    const limiter = new ConcurrencyLimiter(2);
    let active = 0;
    let maxActive = 0;

    const task = async (delayMs: number) => {
      await limiter.acquire();
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, delayMs));
      active--;
      limiter.release();
    };

    await Promise.all([
      task(10), task(10), task(10), task(10)
    ]);

    expect(maxActive).toBe(2);
  });

  it('supports abort signal while in queue', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await limiter.acquire(); // takes the only slot

    const ac = new AbortController();
    const p = limiter.acquire(ac.signal);
    ac.abort();

    await expect(p).rejects.toThrow(/Aborted/);
    limiter.release(); // release first slot
  });
});

describe('LmStudioClient', () => {
  let client: LmStudioClient;
  
  beforeEach(() => {
    client = new LmStudioClient('http://localhost:1234/v1');
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('listModels returns models', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({ data: [{ id: 'model-a' }, { id: 'model-b' }] })
    };
    // @ts-expect-error vi mock
    global.fetch.mockResolvedValue(mockResponse);

    const models = await client.listModels();
    expect(models).toEqual(['model-a', 'model-b']);
  });

  it('throws friendly error when LM Studio is down', async () => {
    // @ts-expect-error vi mock
    global.fetch.mockRejectedValue(new TypeError('fetch failed'));
    await expect(client.listModels()).rejects.toThrow(/Is LM Studio running\?/);
  });

  it('chat parses SSE chunks correctly', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":" World"}}]}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      }
    });

    const mockResponse = {
      ok: true,
      body: stream
    };
    // @ts-expect-error vi mock
    global.fetch.mockResolvedValue(mockResponse);

    let tokens = '';
    const res = await client.chat(
      { model: 'model-a', messages: [{ role: 'user', content: 'Hi' }] },
      (t) => tokens += t
    );

    expect(tokens).toBe('Hello World');
    expect(res.message.content).toBe('Hello World');
    expect(res.message.role).toBe('assistant');
  });

  it('does not drop a data line split across two read() chunks', async () => {
    const line = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n';
    const cut = 30; // split mid-JSON
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(line.slice(0, cut)));
        controller.enqueue(new TextEncoder().encode(line.slice(cut)));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      }
    });
    // @ts-expect-error vi mock
    global.fetch.mockResolvedValue({ ok: true, body: stream });

    let tokens = '';
    const res = await client.chat(
      { model: 'm', messages: [{ role: 'user', content: 'Hi' }] },
      (t) => (tokens += t)
    );
    expect(tokens).toBe('Hello');
    expect(res.message.content).toBe('Hello');
  });

  it('assembles tool_calls whose arguments are split across chunks', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"search","arguments":"{\\"q\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"cats\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n'
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      }
    });
    // @ts-expect-error vi mock
    global.fetch.mockResolvedValue({ ok: true, body: stream });

    const res = await client.chat(
      { model: 'm', messages: [{ role: 'user', content: 'Hi' }] },
      () => {}
    );
    expect(res.message.tool_calls).toHaveLength(1);
    expect(res.message.tool_calls![0].function.name).toBe('search');
    expect(res.message.tool_calls![0].function.arguments).toBe('{"q":"cats"}');
    expect(JSON.parse(res.message.tool_calls![0].function.arguments)).toEqual({ q: 'cats' });
  });

  it('does not kill a steadily streaming call', async () => {
    const stream = new ReadableStream({
      start(controller) {
        for (const w of ['a', 'b', 'c', 'd']) {
          controller.enqueue(
            new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"${w}"}}]}\n\n`)
          );
        }
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      }
    });
    // @ts-expect-error vi mock
    global.fetch.mockResolvedValue({ ok: true, body: stream });

    let tokens = '';
    await client.chat(
      { model: 'm', messages: [{ role: 'user', content: 'Hi' }] },
      (t) => (tokens += t),
      undefined,
      { firstTokenTimeoutMs: 5000, interTokenTimeoutMs: 5000, overallTimeoutMs: 60000 }
    );
    expect(tokens).toBe('abcd');
  });

  it('rejects when the caller aborts mid-request', async () => {
    // @ts-expect-error vi mock
    global.fetch.mockImplementation((_url: string, opts: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const ac = new AbortController();
    const p = client.chat(
      { model: 'm', messages: [{ role: 'user', content: 'Hi' }] },
      () => {},
      ac.signal
    );
    ac.abort();
    await expect(p).rejects.toThrow(/aborted/i);
  });

  it('first-token stall fires and leaves no pending timers', async () => {
    vi.useFakeTimers();
    try {
      // @ts-expect-error vi mock
      global.fetch.mockImplementation((_url: string, opts: { signal: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      });

      const p = client.chat(
        { model: 'm', messages: [{ role: 'user', content: 'Hi' }] },
        () => {},
        undefined,
        { firstTokenTimeoutMs: 1000, interTokenTimeoutMs: 60000, overallTimeoutMs: 600000 }
      );
      const assertion = expect(p).rejects.toThrow(/stall/i);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('inter-token stall fires after the first token', async () => {
    vi.useFakeTimers();
    try {
      // @ts-expect-error vi mock
      global.fetch.mockImplementation((_url: string, opts: { signal: AbortSignal }) => {
        let sentFirst = false;
        const stream = new ReadableStream({
          pull(controller) {
            if (!sentFirst) {
              sentFirst = true;
              controller.enqueue(
                new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n')
              );
              return;
            }
            // Second read hangs until the request is aborted.
            return new Promise<void>((_res, rej) => {
              opts.signal.addEventListener('abort', () => rej(new Error('aborted')));
            });
          }
        });
        return Promise.resolve({ ok: true, body: stream });
      });

      let tokens = '';
      const p = client.chat(
        { model: 'm', messages: [{ role: 'user', content: 'Hi' }] },
        (t) => (tokens += t),
        undefined,
        { firstTokenTimeoutMs: 10000, interTokenTimeoutMs: 1000, overallTimeoutMs: 600000 }
      );
      const assertion = expect(p).rejects.toThrow(/stall/i);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(tokens).toBe('Hi');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
