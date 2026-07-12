import { useEffect, useState } from 'react';
import type { WebhookConfig } from '@acs/core';
import { call } from '../lib/api.js';

interface WebhookFormState {
  id?: string;
  name: string;
  description: string;
  method: 'GET' | 'POST';
  url: string;
  parameterized: boolean;
  headers: string;
  enabled: boolean;
}

const emptyForm: WebhookFormState = { name: '', description: '', method: 'GET', url: '', parameterized: false, headers: '', enabled: true };

function parseHeaders(headersStr: string): Record<string, string> | undefined {
  const lines = headersStr.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

export function WebhookRegistrySection() {
  const [webhooks, setWebhooks] = useState<WebhookConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<WebhookFormState | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [blockedDelete, setBlockedDelete] = useState<{ name: string; spaces: string[] } | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      setWebhooks(await call(window.acs.webhooks.list()));
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

  function toPayload(f: WebhookFormState) {
    return {
      name: f.name,
      description: f.description,
      method: f.method,
      url: f.url,
      parameterized: f.parameterized,
      headers: parseHeaders(f.headers),
      enabled: f.enabled
    };
  }

  async function save() {
    if (!form) return;
    setError(null);
    try {
      if (form.id) {
        await call(window.acs.webhooks.update({ ...toPayload(form), id: form.id }));
      } else {
        await call(window.acs.webhooks.create(toPayload(form)));
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
      const res = await call(window.acs.webhooks.test(toPayload(form)));
      setTestResult(res.ok ? { ok: true, message: `Connected. Snippet: ${res.snippet}` } : { ok: false, message: `Failed: ${res.snippet}` });
    } catch (e) {
      setTestResult({ ok: false, message: (e as Error).message });
    } finally {
      setTesting(false);
    }
  }

  async function remove(webhook: WebhookConfig) {
    const res = await call(window.acs.webhooks.delete(webhook.id));
    if (!res.success) {
      setBlockedDelete({ name: webhook.name, spaces: res.affectedSpaces });
      return;
    }
    await refresh();
  }

  function edit(webhook: WebhookConfig) {
    setForm({
      id: webhook.id,
      name: webhook.name,
      description: webhook.description,
      method: webhook.method,
      url: webhook.url,
      parameterized: webhook.parameterized,
      headers: Object.entries(webhook.headers ?? {})
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n'),
      enabled: webhook.enabled
    });
    setTestResult(null);
  }

  return (
    <div style={{ marginTop: 40 }}>
      <div className="page-header">
        <div>
          <h1>Webhooks</h1>
          <p className="subtitle">Register simple HTTP REST endpoints for agents to query.</p>
        </div>
        <button className="btn btn-primary" onClick={() => { setForm({ ...emptyForm }); setTestResult(null); }}>
          Add webhook
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
            <label>Description</label>
            <input type="text" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            <div className="field-hint">Tells the AI what data this returns.</div>
          </div>
          <div className="field">
            <label>Method</label>
            <select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value as 'GET' | 'POST' })}>
              <option value="GET">GET</option>
              <option value="POST">POST</option>
            </select>
          </div>
          <div className="field">
            <label>URL</label>
            <input type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://api.example.com/data" />
          </div>
          <div className="field">
            <label>
              <input type="checkbox" checked={form.parameterized} onChange={(e) => setForm({ ...form, parameterized: e.target.checked })} /> Accepts query parameter?
            </label>
            <div className="field-hint">If yes, agents can supply a search argument. (GET: appended as ?query= or replaces {'{query}'}, POST: JSON body {'{"query":"..."}'})</div>
          </div>
          <div className="field">
            <label>Headers (one Header: Value per line)</label>
            <textarea value={form.headers} onChange={(e) => setForm({ ...form, headers: e.target.value })} placeholder="Authorization: Bearer my-token" />
          </div>
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
      ) : webhooks.length === 0 ? (
        <div className="empty-state">No webhooks registered yet.</div>
      ) : (
        <table className="list-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Method</th>
              <th>Enabled</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {webhooks.map((w) => (
              <tr key={w.id}>
                <td>{w.name}</td>
                <td>{w.method}</td>
                <td>{w.enabled ? 'Yes' : 'No'}</td>
                <td className="row">
                  <button className="btn-link" onClick={() => edit(w)}>
                    Edit
                  </button>
                  <button className="btn-link" onClick={() => remove(w)}>
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
