import { test, expect, afterEach } from 'vitest';
import { openDatabase, createRepositories } from './index.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { rmSync } from 'fs';

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

test('public API: openDatabase migrates all domain tables and createRepositories wires repos', () => {
  const dbPath = join(tmpdir(), `api-test-${randomUUID()}.sqlite`);
  const db = openDatabase(dbPath);
  cleanup = () => {
    db.close();
    rmSync(dbPath, { force: true });
  };

  const tables = db
    .getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => (r as { name: string }).name);

  for (const t of ['mcp_servers', 'spaces', 'space_mcp', 'agents', 'runs', 'run_events']) {
    expect(tables).toContain(t);
  }

  const repos = createRepositories(db);
  expect(repos.mcpServers).toBeDefined();
  expect(repos.spaces).toBeDefined();
  expect(repos.agents).toBeDefined();
  expect(repos.runs).toBeDefined();
  expect(repos.runEvents).toBeDefined();
});
