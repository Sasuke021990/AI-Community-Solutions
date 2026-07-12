import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchWebhook } from './WebhookClient.js';
import { WebhookConfig } from '../domain/types.js';

describe('WebhookClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('performs a GET request with query param', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'result text'
    });

    const w: WebhookConfig = {
      id: '1', name: 'W', description: '', method: 'GET', url: 'http://test.com/api', parameterized: true, enabled: true, createdAt: 0
    };
    
    const res = await fetchWebhook(w, 'my query');
    expect(res.ok).toBe(true);
    expect(res.body).toBe('result text');
    expect(global.fetch).toHaveBeenCalledWith('http://test.com/api?query=my%20query', expect.objectContaining({ method: 'GET' }));
  });

  it('performs a GET request with {query} placeholder', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'result text'
    });

    const w: WebhookConfig = {
      id: '1', name: 'W', description: '', method: 'GET', url: 'http://test.com/api/{query}/data', parameterized: true, enabled: true, createdAt: 0
    };
    
    const res = await fetchWebhook(w, 'foo');
    expect(res.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith('http://test.com/api/foo/data', expect.objectContaining({ method: 'GET' }));
  });

  it('performs a POST request with JSON body', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"data": "value"}'
    });

    const w: WebhookConfig = {
      id: '1', name: 'W', description: '', method: 'POST', url: 'http://test.com/api', parameterized: true, enabled: true, createdAt: 0
    };
    
    const res = await fetchWebhook(w, 'query text');
    expect(res.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith('http://test.com/api', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ query: 'query text' })
    }));
  });
  
  it('truncates large responses', async () => {
    const hugeText = 'A'.repeat(10000);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => hugeText
    });

    const w: WebhookConfig = {
      id: '1', name: 'W', description: '', method: 'GET', url: 'http://test.com/api', parameterized: false, enabled: true, createdAt: 0
    };
    
    const res = await fetchWebhook(w);
    expect(res.ok).toBe(true);
    expect(res.body.length).toBeLessThan(8200);
    expect(res.body).toContain('...[truncated');
  });
});
