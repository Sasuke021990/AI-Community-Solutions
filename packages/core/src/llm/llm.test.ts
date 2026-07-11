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
});
