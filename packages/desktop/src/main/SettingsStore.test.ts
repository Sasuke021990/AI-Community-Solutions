import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SettingsStore } from './SettingsStore.js';

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('SettingsStore', () => {
  it('creates the file with defaults on first use', () => {
    dir = mkdtempSync(join(tmpdir(), 'acs-settings-'));
    const store = new SettingsStore(join(dir, 'settings.json'));
    expect(store.get().lmStudioBaseUrl).toBe('http://localhost:1234/v1');
    expect(store.get().concurrencyCap).toBe(2);
    expect(store.get().firstTokenTimeoutSec).toBe(120);
    expect(store.get().interTokenTimeoutSec).toBe(60);
  });

  it('merges caller-supplied defaults', () => {
    dir = mkdtempSync(join(tmpdir(), 'acs-settings-'));
    const store = new SettingsStore(join(dir, 'settings.json'), { reportsFolder: '/x/reports' });
    expect(store.get().reportsFolder).toBe('/x/reports');
  });

  it('persists updates and reloads them in a new instance', () => {
    dir = mkdtempSync(join(tmpdir(), 'acs-settings-'));
    const file = join(dir, 'settings.json');
    const store1 = new SettingsStore(file);
    store1.update({ concurrencyCap: 6 });

    const store2 = new SettingsStore(file);
    expect(store2.get().concurrencyCap).toBe(6);
  });

  it('falls back to defaults when the settings file is corrupt', () => {
    dir = mkdtempSync(join(tmpdir(), 'acs-settings-'));
    const file = join(dir, 'settings.json');
    writeFileSync(file, '{ not valid json', 'utf-8');
    const store = new SettingsStore(file);
    expect(store.get().concurrencyCap).toBe(2);
  });

  it('notifies onChange listeners with the new settings', () => {
    dir = mkdtempSync(join(tmpdir(), 'acs-settings-'));
    const store = new SettingsStore(join(dir, 'settings.json'));
    const seen: number[] = [];
    const unsub = store.onChange((s) => seen.push(s.concurrencyCap));
    store.update({ concurrencyCap: 3 });
    unsub();
    store.update({ concurrencyCap: 7 });
    expect(seen).toEqual([3]);
  });
});
