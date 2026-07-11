import { useEffect, useState } from 'react';
import type { Agent, McpServerConfig, RoleTemplate, Space } from '@acs/core';
import type { SpaceWithActivity } from '../../../preload/index.js';
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
  onPublished: () => void;
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

export function SpaceBuilderScreen({ spaceId, onCreated, onOpenRun, onPublished, onBack }: SpaceBuilderScreenProps) {
  const [space, setSpace] = useState<SpaceWithActivity | null>(null);
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
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [publishing, setPublishing] = useState(false);

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
    // Every time we land on a different Space (including right after
    // creating one), the details form starts collapsed - not on every
    // incidental refresh triggered by agent edits or Save changes.
    setDetailsExpanded(false);
    setConfirmPublish(false);
    setPublishIssues(null);
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

  async function confirmAndPublish() {
    if (!space) return;
    setPublishing(true);
    setError(null);
    setPublishIssues(null);
    try {
      const result = await call(window.acs.spaces.publish(space.id));
      if (!result.success) {
        setPublishIssues(result.issues);
        setConfirmPublish(false);
        return;
      }
      setConfirmPublish(false);
      onPublished();
    } catch (e) {
      setError((e as Error).message);
      setConfirmPublish(false);
    } finally {
      setPublishing(false);
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
  const isPreset = !!space?.presetId;
  // Name/description/strategy are locked when the Space is published OR when it
  // came from a preset (its structure is fixed either way).
  const isEditingLocked = isPublished || isPreset;

  const sortedAgents = [...agents].sort((a, b) => a.position - b.position);
  const strategyLabel = STRATEGIES.find((s) => s.value === form.strategy)?.label;

  return (
    <div>
      <div className="page-header">
        <div>
          <button className="btn-link" onClick={onBack} style={{ paddingLeft: 0 }}>
            &larr; Spaces
          </button>
          <h1>{space ? space.name : 'New Space'}</h1>
          {space && <StatusBadge status={space.status} />}
          {space?.hasActiveRun && <span className="badge badge-running">running</span>}
        </div>
        {isPublished && space && (
          <div className="row">
            <button className="btn btn-primary" onClick={() => onOpenRun(space.id)}>
              Run this Space
            </button>
            {space.hasActiveRun ? (
              <span className="field-hint">Unpublish disabled while a run is active.</span>
            ) : (
              <button className="btn" onClick={unpublish}>
                Unpublish to edit
              </button>
            )}
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

      {space && !isPublished && !detailsExpanded ? (
        <div className="card" style={{ maxWidth: 560, marginBottom: 20 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <strong>{space.name}</strong>
              {isPreset && <span className="badge badge-info" style={{ marginLeft: 8 }}>Preset</span>}
              <div className="field-hint">
                {strategyLabel} · {form.defaultModel || 'no default model set'} · max {form.maxRounds} round(s)
              </div>
            </div>
            <button className="btn-link" onClick={() => setDetailsExpanded(true)}>
              Edit details
            </button>
          </div>
        </div>
      ) : (
        <div className="card" style={{ maxWidth: 560, marginBottom: 20 }}>
          {isPreset && (
            <div className="banner banner-info" style={{ marginBottom: 16 }}>
              This Space was created from a preset. Name, description, strategy, and agent roster are locked.
            </div>
          )}
          <div className="field">
            <label>Name</label>
            <input
              type="text"
              value={form.name}
              disabled={isEditingLocked}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Description</label>
            <textarea
              value={form.description}
              disabled={isEditingLocked}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={2}
            />
          </div>
          <div className="field">
            <label>Coordination strategy</label>
            <select
              value={form.strategy}
              disabled={isEditingLocked}
              onChange={(e) => setForm({ ...form, strategy: e.target.value as Space['strategy'] })}
            >
              {STRATEGIES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <div className="field-hint">{strategyLabel && STRATEGIES.find((s) => s.value === form.strategy)?.hint}</div>
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
                <button className="btn-link" onClick={() => setDetailsExpanded(false)}>
                  Hide details
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {space && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div className="section-title" style={{ margin: '20px 0 8px' }}>
              Agents {sortedAgents.length > 8 && <span style={{ color: 'var(--warning)' }}>({sortedAgents.length} - consider fewer for local hardware)</span>}
            </div>
          </div>

          {sortedAgents.map((agent, i) =>
            editingAgent !== 'new' && editingAgent && (editingAgent as Agent).id === agent.id ? (
              <AgentEditor
                key={agent.id}
                spaceId={space.id}
                strategy={form.strategy}
                roleTemplates={roleTemplates}
                models={models}
                nextPosition={sortedAgents.length}
                existingAgent={agent}
                locked={isPreset}
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
                    {!isPreset && (
                      <>
                        <button className="btn-link" onClick={() => moveAgent(agent, -1)} disabled={i === 0}>
                          ↑
                        </button>
                        <button className="btn-link" onClick={() => moveAgent(agent, 1)} disabled={i === sortedAgents.length - 1}>
                          ↓
                        </button>
                      </>
                    )}
                    <button className="btn-link" onClick={() => setEditingAgent(agent)}>
                      Edit
                    </button>
                    {!isPreset && (
                      <button className="btn-link" onClick={() => deleteAgent(agent)}>
                        Delete
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          )}

          {editingAgent === 'new' && (
            <AgentEditor
              spaceId={space.id}
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
            <div className="row">
              {!isPreset && (
                <button className="btn" onClick={() => setEditingAgent('new')}>
                  Add agent
                </button>
              )}
              <button className="btn btn-primary" onClick={() => setConfirmPublish(true)}>
                Publish
              </button>
            </div>
          )}

          {confirmPublish && (
            <div className="banner banner-info" style={{ marginTop: 12 }}>
              Publish this Space? Agents and settings will be locked until you unpublish.
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn btn-primary" onClick={confirmAndPublish} disabled={publishing}>
                  {publishing ? 'Publishing...' : 'Confirm publish'}
                </button>
                <button className="btn" onClick={() => setConfirmPublish(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
