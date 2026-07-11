import { useState } from 'react';
import type { Agent, RoleTemplate, Strategy } from '@acs/core';
import { call } from '../lib/api.js';

interface AgentEditorProps {
  spaceId: string;
  spaceDescription: string;
  strategy: Strategy;
  roleTemplates: RoleTemplate[];
  models: string[];
  nextPosition: number;
  existingAgent: Agent | null;
  onSaved: () => void;
  onCancel: () => void;
}

export function AgentEditor({
  spaceId,
  spaceDescription,
  strategy,
  roleTemplates,
  models,
  nextPosition,
  existingAgent,
  onSaved,
  onCancel
}: AgentEditorProps) {
  const [name, setName] = useState(existingAgent?.name ?? '');
  const [role, setRole] = useState(existingAgent?.role ?? '');
  const [systemPrompt, setSystemPrompt] = useState(existingAgent?.systemPrompt ?? '');
  const [modelId, setModelId] = useState(existingAgent?.modelId ?? '');
  const [isOrchestrator, setIsOrchestrator] = useState(existingAgent?.isOrchestrator ?? false);
  const [templateId, setTemplateId] = useState('custom');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function applyTemplate(id: string) {
    setTemplateId(id);
    if (id === 'custom') return;
    const template = roleTemplates.find((t) => t.id === id);
    if (!template) return;
    try {
      const { content } = await call(
        window.acs.templates.render(template.id, name.trim() || 'Agent', spaceDescription)
      );
      setSystemPrompt(content);
      setRole(template.name);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function save() {
    if (!name.trim() || !role.trim() || !systemPrompt.trim()) {
      setError('Name, role, and system prompt are all required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        spaceId,
        name: name.trim(),
        role: role.trim(),
        systemPrompt: systemPrompt.trim(),
        modelId: modelId || undefined,
        isOrchestrator,
        position: existingAgent?.position ?? nextPosition
      };
      if (existingAgent) {
        await call(window.acs.agents.update({ ...payload, id: existingAgent.id }));
      } else {
        await call(window.acs.agents.create(payload));
      }
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      {error && <div className="banner banner-error">{error}</div>}

      <div className="field">
        <label>Agent name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Researcher" />
      </div>

      <div className="field">
        <label>Role template</label>
        <select value={templateId} onChange={(e) => applyTemplate(e.target.value)}>
          <option value="custom">Custom (write your own)</option>
          {roleTemplates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} - {t.description}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label>Role title</label>
        <input type="text" value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Researcher" />
      </div>

      {strategy === 'orchestrator' && (
        <div className="field">
          <label>
            <input type="checkbox" checked={isOrchestrator} onChange={(e) => setIsOrchestrator(e.target.checked)} /> This
            agent is the orchestrator
          </label>
          <div className="field-hint">Exactly one agent must be the orchestrator for this strategy.</div>
        </div>
      )}

      <button type="button" className="advanced-toggle" onClick={() => setShowAdvanced(!showAdvanced)}>
        {showAdvanced ? 'Hide advanced' : 'Show advanced (system prompt, model override)'}
      </button>

      {showAdvanced && (
        <>
          <div className="field" style={{ marginTop: 12 }}>
            <label>System prompt</label>
            <textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} rows={6} />
          </div>
          <div className="field">
            <label>Model override</label>
            <select value={modelId} onChange={(e) => setModelId(e.target.value)}>
              <option value="">Use Space default</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        </>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving...' : 'Save agent'}
        </button>
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
