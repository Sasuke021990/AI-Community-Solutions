import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface Settings {
  lmStudioBaseUrl: string;
  concurrencyCap: number;
  reportsFolder: string;
  /** Budget for queueing + prompt processing before the first real token (seconds). */
  firstTokenTimeoutSec: number;
  /** Max silence between tokens once generation has actually started (seconds). */
  interTokenTimeoutSec: number;
}

export type SettingsPatch = Partial<Settings>;

const DEFAULTS: Settings = {
  lmStudioBaseUrl: 'http://localhost:1234/v1',
  concurrencyCap: 2,
  reportsFolder: '',
  firstTokenTimeoutSec: 120,
  interTokenTimeoutSec: 60
};

/**
 * Simple JSON-file settings store. Deliberately has no Electron dependency
 * so it is unit-testable in isolation; the caller supplies the file path
 * (main/index.ts derives it from app.getPath('userData')).
 */
export class SettingsStore {
  private settings: Settings;
  private listeners = new Set<(s: Settings) => void>();

  constructor(
    private filePath: string,
    defaults: Partial<Settings> = {}
  ) {
    const merged = { ...DEFAULTS, ...defaults };
    if (existsSync(filePath)) {
      try {
        const onDisk = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<Settings>;
        this.settings = { ...merged, ...onDisk };
      } catch {
        // Corrupt settings file: fall back to defaults rather than crash the app.
        this.settings = merged;
      }
    } else {
      this.settings = merged;
      this.persist();
    }
  }

  public get(): Settings {
    return { ...this.settings };
  }

  public update(patch: SettingsPatch): Settings {
    this.settings = { ...this.settings, ...patch };
    this.persist();
    for (const cb of this.listeners) cb(this.get());
    return this.get();
  }

  /** Subscribe to settings changes (used to re-sync LmStudioClient/limiter). */
  public onChange(cb: (s: Settings) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.settings, null, 2), 'utf-8');
  }
}
