import { useEffect, useState } from 'react';
import type { McpServerConfig } from '@acs/core';
import { call } from '../lib/api.js';

interface FormState {
  id?: string;
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string;
  env: string;
  url: string;
  enabled: boolean;
}

const emptyForm: FormState = { name: '', transport: 'stdio', command: '', args: '', env: '', url: '', enabled: true };

function parseArgs(args: string): string[] | undefined {
  const trimmed = args.trim();
  return trimmed === '' ? undefined : trimmed.split(/\s+/);
}

function parseEnv(env: string): Record<string, string> | undefined {
  const lines = env
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

export function McpRegistryScreen() {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [blockedDelete, setBlockedDelete] = useState<{ name: string; spaces: string[] } | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      setServers(await call(window.acs.mcp.list()));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function toPayload(f: FormState) {
    return {
      name: f.name,
      transport: f.transport,
      command: f.transport === 'stdio' ? f.command : undefined,
      args: f.transport === 'stdio' ? parseArgs(f.args) : undefined,
      env: f.transport === 'stdio' ? parseEnv(f.env) : undefined,
      url: f.transport === 'http' ? f.url : undefined,
      enabled: f.enabled
    };
  }

  async function save() {
    if (!form) return;
    setError(null);
    try {
      if (form.id) {
        await call(window.acs.mcp.update({ ...toPayload(form), id: form.id }));
      } else {
        await call(window.acs.mcp.create(toPayload(form)));
      }
      setForm(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function testForm() {
    if (!form) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await call(window.acs.mcp.test(toPayload(form)));
      setTestResult(res.ok ? { ok: true, message: `Connected. Tools: ${(res.tools ?? []).join(', ') || '(none)'}` } : { ok: false, message: res.error ?? 'Connection failed' });
    } catch (e) {
      setTestResult({ ok: false, message: (e as Error).message });
    } finally {
      setTesting(false);
    }
  }

  async function remove(server: McpServerConfig) {
    const res = await call(window.acs.mcp.delete(server.id));
    if (!res.success) {
      setBlockedDelete({ name: server.name, spaces: res.affectedSpaces });
      return;
    }
    await refresh();
  }

  function edit(server: McpServerConfig) {
    setForm({
      id: server.id,
      name: server.name,
      transport: server.transport,
      command: server.command ?? '',
      args: (server.args ?? []).join(' '),
      env: Object.entries(server.env ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
      url: server.url ?? '',
      enabled: server.enabled
    });
    setTestResult(null);
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>MCP Servers</h1>
          <p className="subtitle">Register tool servers; Spaces choose which of these they may use.</p>
        </div>
        <button className="btn btn-primary" onClick={() => { setForm({ ...emptyForm }); setTestResult(null); }}>
          Add server
        </button>
      </div>

      {error && <div className="banner banner-error">{error}</div>}
      {blockedDelete && (
        <div className="banner banner-error">
          Cannot delete "{blockedDelete.name}" - it is used by published Space(s): {blockedDelete.spaces.join(', ')}.
          <button className="btn-link" onClick={() => setBlockedDelete(null)}>
            Dismiss
          </button>
        </div>
      )}

      {form && (
        <div className="card" style={{ maxWidth: 480, marginBottom: 20 }}>
          <div className="field">
            <label>Name</label>
            <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="field">
            <label>Transport</label>
            <select value={form.transport} onChange={(e) => setForm({ ...form, transport: e.target.value as 'stdio' | 'http' })}>
              <option value="stdio">stdio (local command)</option>
              <option value="http">http (URL)</option>
            </select>
          </div>
          {form.transport === 'stdio' ? (
            <>
              <div className="field">
                <label>Command</label>
                <input type="text" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="npx" />
              </div>
              <div className="field">
                <label>Args (space-separated)</label>
                <input type="text" value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} placeholder="-y some-mcp-server" />
              </div>
              <div className="field">
                <label>Env (one KEY=VALUE per line)</label>
                <textarea value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })} />
              </div>
            </>
          ) : (
            <div className="field">
              <label>URL</label>
              <input type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="http://localhost:9000" />
            </div>
          )}
          <div className="field">
            <label>
              <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Enabled
            </label>
          </div>
          <div className="row">
            <button className="btn btn-primary" onClick={save}>
              {form.id ? 'Save' : 'Add'}
            </button>
            <button className="btn" onClick={testForm} disabled={testing}>
              {testing ? 'Testing...' : 'Test connection'}
            </button>
            <button className="btn" onClick={() => setForm(null)}>
              Cancel
            </button>
          </div>
          {testResult && (
            <div className={`banner ${testResult.ok ? 'banner-info' : 'banner-error'}`} style={{ marginTop: 12 }}>
              {testResult.message}
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="empty-state">Loading...</div>
      ) : servers.length === 0 ? (
        <div className="empty-state">No MCP servers registered yet.</div>
      ) : (
        <table className="list-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Transport</th>
              <th>Enabled</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {servers.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td>{s.transport}</td>
                <td>{s.enabled ? 'Yes' : 'No'}</td>
                <td className="row">
                  <button className="btn-link" onClick={() => edit(s)}>
                    Edit
                  </button>
                  <button className="btn-link" onClick={() => remove(s)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
