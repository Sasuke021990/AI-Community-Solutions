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
});
