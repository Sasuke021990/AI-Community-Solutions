import { describe, it, expect } from 'vitest';
import { McpClientWrapper } from './McpClient.js';

describe('McpClientWrapper', () => {
  it('exposes the configured server name', () => {
    const c = new McpClientWrapper({
      id: 'x', name: 'MyServer', transport: 'stdio', command: 'echo', enabled: true, createdAt: 0
    });
    expect(c.name).toBe('MyServer');
  });

  it('testConnection returns a structured error for an invalid stdio command', async () => {
    const c = new McpClientWrapper({
      id: 'x', name: 'bad', transport: 'stdio',
      command: 'this-command-truly-does-not-exist-xyz-123', enabled: true, createdAt: 0
    });
    const res = await c.testConnection();
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it('connect() rejects a stdio config with no command', async () => {
    const c = new McpClientWrapper({
      id: 'x', name: 'no-command', transport: 'stdio', enabled: true, createdAt: 0
    });
    await expect(c.connect()).rejects.toThrow(/requires a command/);
  });

  it('connect() rejects an http config with no url', async () => {
    const c = new McpClientWrapper({
      id: 'x', name: 'no-url', transport: 'http', enabled: true, createdAt: 0
    });
    await expect(c.connect()).rejects.toThrow(/requires a URL/);
  });

  it('connect() rejects an unsupported transport', async () => {
    const c = new McpClientWrapper({
      id: 'x', name: 'bogus', transport: 'bogus' as 'stdio', enabled: true, createdAt: 0
    });
    await expect(c.connect()).rejects.toThrow(/Unsupported transport/);
  });

  it('callTool times out and rejects when the underlying call never resolves', async () => {
    const c = new McpClientWrapper(
      { id: 'x', name: 'slow', transport: 'stdio', command: 'echo', enabled: true, createdAt: 0 },
      20 // toolTimeoutMs
    );
    // Bypass a real connect(): stub the private client's callTool to hang forever.
    (c as unknown as { client: { callTool: () => Promise<never> } }).client = {
      callTool: () => new Promise(() => {})
    };
    await expect(c.callTool('search', { q: 'cat' })).rejects.toThrow(/timed out after 20ms/);
  });

  it('callTool resolves with the underlying result when it completes before the timeout', async () => {
    const c = new McpClientWrapper(
      { id: 'x', name: 'fast', transport: 'stdio', command: 'echo', enabled: true, createdAt: 0 },
      5_000
    );
    (c as unknown as { client: { callTool: (args: unknown) => Promise<unknown> } }).client = {
      callTool: async (args) => ({ content: [{ type: 'text', text: JSON.stringify(args) }] })
    };
    const result = await c.callTool('search', { q: 'cat' });
    expect(result).toEqual({ content: [{ type: 'text', text: '{"name":"search","arguments":{"q":"cat"}}' }] });
  });
});
