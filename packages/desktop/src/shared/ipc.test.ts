import { describe, it, expect } from 'vitest';
import { Strategy } from '@acs/core';
import { Channels, McpServerInputSchema, SpaceInputSchema, AgentInputSchema, SettingsPatchSchema } from './ipc.js';

describe('McpServerInputSchema', () => {
  it('accepts a valid stdio config and defaults enabled to true', () => {
    const parsed = McpServerInputSchema.parse({ name: 'srv', transport: 'stdio', command: 'node' });
    expect(parsed.enabled).toBe(true);
  });

  it('rejects stdio transport without a command', () => {
    expect(() => McpServerInputSchema.parse({ name: 'srv', transport: 'stdio' })).toThrow();
  });

  it('rejects http transport without a url', () => {
    expect(() => McpServerInputSchema.parse({ name: 'srv', transport: 'http' })).toThrow();
  });

  it('accepts a valid http config', () => {
    const parsed = McpServerInputSchema.parse({ name: 'srv', transport: 'http', url: 'http://localhost:9999' });
    expect(parsed.url).toBe('http://localhost:9999');
  });
});

describe('SpaceInputSchema', () => {
  it('defaults description to empty string and enforces maxRounds bounds', () => {
    const parsed = SpaceInputSchema.parse({ name: 'S', strategy: Strategy.RoundRobin, defaultModel: 'm', maxRounds: 5 });
    expect(parsed.description).toBe('');
    expect(() => SpaceInputSchema.parse({ name: 'S', strategy: Strategy.RoundRobin, defaultModel: 'm', maxRounds: 0 })).toThrow();
    expect(() => SpaceInputSchema.parse({ name: 'S', strategy: Strategy.RoundRobin, defaultModel: 'm', maxRounds: 51 })).toThrow();
  });

  it('rejects an unknown strategy value', () => {
    expect(() =>
      SpaceInputSchema.parse({ name: 'S', strategy: 'not-a-strategy', defaultModel: 'm', maxRounds: 5 })
    ).toThrow();
  });
});

describe('AgentInputSchema', () => {
  it('requires a non-empty systemPrompt and defaults isOrchestrator to false', () => {
    const parsed = AgentInputSchema.parse({ spaceId: 's', name: 'A', role: 'R', systemPrompt: 'do things', position: 0 });
    expect(parsed.isOrchestrator).toBe(false);
    expect(() =>
      AgentInputSchema.parse({ spaceId: 's', name: 'A', role: 'R', systemPrompt: '', position: 0 })
    ).toThrow();
  });
});

describe('SettingsPatchSchema', () => {
  it('accepts a partial patch with only some fields', () => {
    expect(SettingsPatchSchema.parse({ concurrencyCap: 4 })).toEqual({ concurrencyCap: 4 });
  });

  it('rejects concurrencyCap outside 1-8', () => {
    expect(() => SettingsPatchSchema.parse({ concurrencyCap: 9 })).toThrow();
    expect(() => SettingsPatchSchema.parse({ concurrencyCap: 0 })).toThrow();
  });

  it('rejects a non-URL lmStudioBaseUrl', () => {
    expect(() => SettingsPatchSchema.parse({ lmStudioBaseUrl: 'not a url' })).toThrow();
  });
});

describe('Channels registry', () => {
  it('every channel has a unique name', () => {
    const names = Object.values(Channels).map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
