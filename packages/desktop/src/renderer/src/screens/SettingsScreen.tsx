import { useEffect, useState } from 'react';
import { call } from '../lib/api.js';

interface SettingsForm {
  lmStudioBaseUrl: string;
  concurrencyCap: number;
  reportsFolder: string;
  firstTokenTimeoutSec: number;
  interTokenTimeoutSec: number;
  narrativeModel: string;
}

export function SettingsScreen() {
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    call(window.acs.settings.get())
      .then(setForm)
      .catch((e: Error) => setError(e.message));
    call(window.acs.models.list())
      .then(res => setAvailableModels(res.models))
      .catch(() => {});
  }, []);

  async function save() {
    if (!form) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await call(window.acs.settings.set(form));
      setForm(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const { models } = await call(window.acs.models.list());
      setTestResult({ ok: true, message: `Connected - ${models.length} model(s) available.` });
    } catch (e) {
      setTestResult({ ok: false, message: (e as Error).message });
    } finally {
      setTesting(false);
    }
  }

  if (!form) {
    return <div className="empty-state">{error ?? 'Loading settings...'}</div>;
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p className="subtitle">LM Studio connection and run defaults.</p>
        </div>
      </div>

      {error && <div className="banner banner-error">{error}</div>}

      <div className="card" style={{ maxWidth: 480 }}>
        <div className="field">
          <label>LM Studio base URL</label>
          <input
            type="url"
            value={form.lmStudioBaseUrl}
            onChange={(e) => setForm({ ...form, lmStudioBaseUrl: e.target.value })}
          />
          <div className="field-hint">Default: http://localhost:1234/v1</div>
        </div>

        <div className="field">
          <label>Concurrency cap (1-8)</label>
          <input
            type="number"
            min={1}
            max={8}
            value={form.concurrencyCap}
            onChange={(e) => setForm({ ...form, concurrencyCap: Number(e.target.value) })}
          />
          <div className="field-hint">
            How many LM Studio requests may run at once. A single warm model handles 2+ fine, but agents assigned{' '}
            <strong>different models</strong> will starve each other on one GPU - keep this at 1 if your agents use
            model overrides, or give all agents the same model.
          </div>
        </div>

        <div className="field">
          <label>First-token timeout (seconds)</label>
          <input
            type="number"
            min={10}
            max={900}
            value={form.firstTokenTimeoutSec}
            onChange={(e) => setForm({ ...form, firstTokenTimeoutSec: Number(e.target.value) })}
          />
          <div className="field-hint">
            Budget for queueing + prompt processing before generation starts. Raise this if runs fail while LM Studio
            still shows &quot;Processing prompt&quot;.
          </div>
        </div>

        <div className="field">
          <label>Inter-token stall timeout (seconds)</label>
          <input
            type="number"
            min={10}
            max={900}
            value={form.interTokenTimeoutSec}
            onChange={(e) => setForm({ ...form, interTokenTimeoutSec: Number(e.target.value) })}
          />
          <div className="field-hint">
            Max silence between tokens once generation has started. Raise this on slow hardware or when running
            multiple models.
          </div>
        </div>

        <div className="field">
          <label>Reports folder</label>
          <input
            type="text"
            value={form.reportsFolder}
            onChange={(e) => setForm({ ...form, reportsFolder: e.target.value })}
          />
        </div>

        <div className="field">
          <label>Narrative Summary Model</label>
          <select
            value={form.narrativeModel}
            onChange={(e) => setForm({ ...form, narrativeModel: e.target.value })}
          >
            <option value="None (Raw Transcript)">None (Raw Transcript)</option>
            {availableModels.map(m => (
              <option key={m} value={m}>{m}</option>
            ))}
            {!availableModels.includes(form.narrativeModel) && form.narrativeModel !== 'None (Raw Transcript)' && (
              <option value={form.narrativeModel}>{form.narrativeModel} (Offline)</option>
            )}
          </select>
          <div className="field-hint">
            Model used to generate a narrative summary of the report. Set to &quot;None&quot; to skip LLM summarization.
          </div>
        </div>

        <div className="row">
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button className="btn" onClick={testConnection} disabled={testing}>
            {testing ? 'Testing...' : 'Test connection'}
          </button>
        </div>

        {testResult && (
          <div className={`banner ${testResult.ok ? 'banner-info' : 'banner-error'}`} style={{ marginTop: 12 }}>
            {testResult.message}
          </div>
        )}
      </div>
    </div>
  );
}
