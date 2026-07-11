import { useEffect, useState } from 'react';
import type { Space, Agent, McpServerConfig, RoleTemplate } from '@acs/core';
import { call } from '../lib/api.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { AgentEditor } from '../components/AgentEditor.js';

const STRATEGIES: { value: Space['strategy']; label: string; hint: string }[] = [
  { value: 'orchestrator' as Space['strategy'], label: 'Orchestrator', hint: 'One agent plans and delegates subtasks to the others, then reviews results.' },
  { value: 'round-robin' as Space['strategy'], label: 'Round robin', hint: 'Agents take turns contributing, each seeing the discussion so far.' },
  { value: 'debate' as Space['strategy'], label: 'Debate', hint: 'Agents propose solutions, then critique each other until no objections remain.' }
];

interface SpaceBuilderScreenProps {
  spaceId: string | null;
  onCreated: (id: string) => void;
  onOpenRun: (spaceId: string) => void;
  onBack: () => void;
}

interface SpaceForm {
  name: string;
  description: string;
  strategy: Space['strategy'];
  defaultModel: string;
  maxRounds: number;
  allowedMcpServerIds: string[];
}

function toForm(space: Space): SpaceForm {
  return {
    name: space.name,
    description: space.description,
    strategy: space.strategy,
    defaultModel: space.defaultModel,
    maxRounds: space.maxRounds,
    allowedMcpServerIds: space.allowedMcpServerIds ?? []
  };
}

const emptyForm: SpaceForm = {
  name: '',
  description: '',
  strategy: 'round-robin' as Space['strategy'],
  defaultModel: '',
  maxRounds: 8,
  allowedMcpServerIds: []
};

export function SpaceBuilderScreen({ spaceId, onCreated, onOpenRun, onBack }: SpaceBuilderScreenProps) {
  const [space, setSpace] = useState<Space | null>(null);
  const [form, setForm] = useState<SpaceForm>(emptyForm);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);
  const [roleTemplates, setRoleTemplates] = useState<RoleTemplate[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(spaceId !== null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [publishIssues, setPublishIssues] = useState<{ field?: string; message: string }[] | null>(null);
  const [editingAgent, setEditingAgent] = useState<Agent | 'new' | null>(null);

  async function loadModels() {
    try {
      const { models } = await call(window.acs.models.list());
      setModels(models);
      setModelsError(null);
    } catch (e) {
      setModelsError((e as Error).message);
    }
  }

  async function loadAll(id: string) {
    setLoading(true);
    try {
      const [s, a] = await Promise.all([call(window.acs.spaces.get(id)), call(window.acs.agents.listBySpace(id))]);
      if (!s) throw new Error('Space not found');
      setSpace(s);
      setForm(toForm(s));
      setAgents(a);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    call(window.acs.mcp.list()).then(setMcpServers).catch(() => {});
    call(window.acs.templates.list()).then(setRoleTemplates).catch(() => {});
    loadModels();
  }, []);

  useEffect(() => {
    if (spaceId) {
      loadAll(spaceId);
    } else {
      setSpace(null);
      setForm(emptyForm);
      setAgents([]);
      setLoading(false);
    }
  }, [spaceId]);

  function toggleMcp(id: string) {
    setForm((f) => ({
      ...f,
      allowedMcpServerIds: f.allowedMcpServerIds.includes(id)
        ? f.allowedMcpServerIds.filter((x) => x !== id)
        : [...f.allowedMcpServerIds, id]
    }));
  }

  async function createSpace() {
    if (!form.name.trim() || !form.defaultModel) {
      setError('Name and a default model are required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = await call(window.acs.spaces.create(form));
      setSpace(created);
      onCreated(created.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function saveSpace() {
    if (!space) return;
    setSaving(true);
    setError(null);
    try {
      await call(window.acs.spaces.update({ ...form, id: space.id }));
      await loadAll(space.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function publish() {
    if (!space) return;
    setError(null);
    setPublishIssues(null);
    try {
      const result = await call(window.acs.spaces.publish(space.id));
      if (!result.success) {
        setPublishIssues(result.issues);
        return;
      }
      await loadAll(space.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function unpublish() {
    if (!space) return;
    try {
      await call(window.acs.spaces.unpublish(space.id));
      await loadAll(space.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deleteAgent(agent: Agent) {
    if (!space) return;
    try {
      await call(window.acs.agents.delete(agent.id, space.id));
      await loadAll(space.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function moveAgent(agent: Agent, direction: -1 | 1) {
    if (!space) return;
    const sorted = [...agents].sort((a, b) => a.position - b.position);
    const idx = sorted.findIndex((a) => a.id === agent.id);
    const swapIdx = idx + direction;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;
    const other = sorted[swapIdx];
    try {
      await Promise.all([
        call(
          window.acs.agents.update({ ...agent, modelId: agent.modelId ?? undefined, position: other.position })
        ),
        call(
          window.acs.agents.update({ ...other, modelId: other.modelId ?? undefined, position: agent.position })
        )
      ]);
      await loadAll(space.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (loading) return <div className="empty-state">Loading...</div>;

  const isPublished = space?.status === 'published';
  const sortedAgents = [...agents].sort((a, b) => a.position - b.position);

  return (
    <div>
      <div className="page-header">
        <div>
          <button className="btn-link" onClick={onBack} style={{ paddingLeft: 0 }}>
            &larr; Spaces
          </button>
          <h1>{space ? space.name : 'New Space'}</h1>
          {space && <StatusBadge status={space.status} />}
        </div>
        {isPublished && space && (
          <div className="row">
            <button className="btn btn-primary" onClick={() => onOpenRun(space.id)}>
              Run this Space
            </button>
            <button className="btn" onClick={unpublish}>
              Unpublish to edit
            </button>
          </div>
        )}
      </div>

      {error && <div className="banner banner-error">{error}</div>}
      {publishIssues && publishIssues.length > 0 && (
        <div className="banner banner-error">
          Cannot publish:
          <ul style={{ margin: '4px 0 0 18px' }}>
            {publishIssues.map((issue, i) => (
              <li key={i}>{issue.message}</li>
            ))}
          </ul>
        </div>
      )}
      {modelsError && <div className="banner banner-error">Could not load models: {modelsError}</div>}

      <div className="card" style={{ maxWidth: 560, marginBottom: 20 }}>
        <div className="field">
          <label>Name</label>
          <input
            type="text"
            value={form.name}
            disabled={isPublished}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>
        <div className="field">
          <label>Description</label>
          <textarea
            value={form.description}
            disabled={isPublished}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            rows={2}
          />
        </div>
        <div className="field">
          <label>Coordination strategy</label>
          <select
            value={form.strategy}
            disabled={isPublished}
            onChange={(e) => setForm({ ...form, strategy: e.target.value as Space['strategy'] })}
          >
            {STRATEGIES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <div className="field-hint">{STRATEGIES.find((s) => s.value === form.strategy)?.hint}</div>
        </div>
        <div className="field">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <label style={{ margin: 0 }}>Default model</label>
            <button type="button" className="btn-link" onClick={loadModels}>
              Refresh
            </button>
          </div>
          <select
            value={form.defaultModel}
            disabled={isPublished}
            onChange={(e) => setForm({ ...form, defaultModel: e.target.value })}
          >
            <option value="">Select a model...</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          {form.defaultModel && models.length > 0 && !models.includes(form.defaultModel) && (
            <div className="field-error">This model is no longer available in LM Studio.</div>
          )}
        </div>
        <div className="field">
          <label>Max rounds</label>
          <input
            type="number"
            min={1}
            max={50}
            value={form.maxRounds}
            disabled={isPublished}
            onChange={(e) => setForm({ ...form, maxRounds: Number(e.target.value) })}
          />
        </div>
        <div className="field">
          <label>Allowed MCP servers</label>
          <div className="checkbox-list">
            {mcpServers.length === 0 && <div className="field-hint">No MCP servers registered yet.</div>}
            {mcpServers.map((m) => (
              <label key={m.id}>
                <input
                  type="checkbox"
                  disabled={isPublished}
                  checked={form.allowedMcpServerIds.includes(m.id)}
                  onChange={() => toggleMcp(m.id)}
                />
                {m.name}
              </label>
            ))}
          </div>
        </div>

        {!isPublished && (
          <div className="row">
            <button className="btn btn-primary" onClick={space ? saveSpace : createSpace} disabled={saving}>
              {saving ? 'Saving...' : space ? 'Save changes' : 'Create Space'}
            </button>
            {space && (
              <button className="btn" onClick={publish}>
                Publish
              </button>
            )}
          </div>
        )}
      </div>

      {space && (
        <>
          <div className="section-title">
            Agents {sortedAgents.length > 8 && <span style={{ color: 'var(--warning)' }}>({sortedAgents.length} - consider fewer for local hardware)</span>}
          </div>

          {sortedAgents.map((agent, i) =>
            editingAgent !== 'new' && editingAgent && (editingAgent as Agent).id === agent.id ? (
              <AgentEditor
                key={agent.id}
                spaceId={space.id}
                spaceDescription={form.description}
                strategy={form.strategy}
                roleTemplates={roleTemplates}
                models={models}
                nextPosition={sortedAgents.length}
                existingAgent={agent}
                onSaved={() => {
                  setEditingAgent(null);
                  loadAll(space.id);
                }}
                onCancel={() => setEditingAgent(null)}
              />
            ) : (
              <div key={agent.id} className="agent-list-item">
                <div className="agent-meta">
                  <div className="agent-name">
                    {agent.name} {agent.isOrchestrator && <span className="badge badge-published">orchestrator</span>}
                  </div>
                  <div className="agent-role">
                    {agent.role} {agent.modelId ? `· ${agent.modelId}` : ''}
                  </div>
                </div>
                {!isPublished && (
                  <div className="row">
                    <button className="btn-link" onClick={() => moveAgent(agent, -1)} disabled={i === 0}>
                      ↑
                    </button>
                    <button className="btn-link" onClick={() => moveAgent(agent, 1)} disabled={i === sortedAgents.length - 1}>
                      ↓
                    </button>
                    <button className="btn-link" onClick={() => setEditingAgent(agent)}>
                      Edit
                    </button>
                    <button className="btn-link" onClick={() => deleteAgent(agent)}>
                      Delete
                    </button>
                  </div>
                )}
              </div>
            )
          )}

          {editingAgent === 'new' && (
            <AgentEditor
              spaceId={space.id}
              spaceDescription={form.description}
              strategy={form.strategy}
              roleTemplates={roleTemplates}
              models={models}
              nextPosition={sortedAgents.length}
              existingAgent={null}
              onSaved={() => {
                setEditingAgent(null);
                loadAll(space.id);
              }}
              onCancel={() => setEditingAgent(null)}
            />
          )}

          {!isPublished && editingAgent === null && (
            <button className="btn" onClick={() => setEditingAgent('new')}>
              Add agent
            </button>
          )}
        </>
      )}
    </div>
  );
}
