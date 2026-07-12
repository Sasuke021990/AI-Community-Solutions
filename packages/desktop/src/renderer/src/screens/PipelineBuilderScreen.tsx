import { useEffect, useState } from 'react';
import type { Space, RoleTemplate } from '@acs/core';
import { call } from '../lib/api.js';

interface PipelineBuilderScreenProps {
  onDone: (spaceId: string) => void;
  onBack: () => void;
}

export function PipelineBuilderScreen({ onDone, onBack }: PipelineBuilderScreenProps) {
  const [name, setName] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  
  const [steps, setSteps] = useState<{ role: string; systemPrompt: string; templateId: string }[]>([
    { role: '', systemPrompt: '', templateId: 'custom' }
  ]);
  const [roleTemplates, setRoleTemplates] = useState<RoleTemplate[]>([]);
  const [frame, setFrame] = useState(true);
  const [synth, setSynth] = useState(true);
  
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function loadModels() {
    try {
      const { models } = await call(window.acs.models.list());
      setModels(models);
      setModelsError(null);
    } catch (e) {
      setModelsError((e as Error).message);
    }
  }

  useEffect(() => {
    loadModels();
    call(window.acs.templates.list()).then(setRoleTemplates).catch(() => {});
  }, []);

  function applyTemplate(idx: number, templateId: string) {
    const newSteps = [...steps];
    newSteps[idx].templateId = templateId;
    if (templateId !== 'custom') {
      const template = roleTemplates.find((t) => t.id === templateId);
      if (template) {
        newSteps[idx].systemPrompt = template.systemPrompt;
        newSteps[idx].role = template.name;
      }
    }
    setSteps(newSteps);
  }

  async function createAndPublish() {
    if (!name.trim() || !defaultModel || steps.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const space = await call(window.acs.spaces.create({
        name,
        strategy: 'structured' as Space['strategy'],
        defaultModel,
        maxRounds: 1,
        description: '',
        allowedMcpServerIds: [],
        allowedWebhookIds: []
      }));

      let pos = 0;
      const wantsFramer = frame || synth;
      if (wantsFramer) {
        await call(window.acs.agents.create({
          spaceId: space.id, name: 'Facilitator', role: 'Facilitator',
          systemPrompt: 'You frame the problem at the start and synthesize the final answer at the end.',
          isOrchestrator: true, position: pos++
        }));
      }

      for (const s of steps) {
        await call(window.acs.agents.create({
          spaceId: space.id, name: s.role || `Step ${pos}`, role: s.role || `Step ${pos}`,
          systemPrompt: s.systemPrompt, isOrchestrator: false, position: pos++
        }));
      }

      const res = await call(window.acs.spaces.publish(space.id));
      if (!res.success) { 
        setError(res.issues.map(i => i.message).join('; ')); 
        return; 
      }
      onDone(space.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <button className="btn-link" onClick={onBack} style={{ paddingLeft: 0, marginBottom: 8 }}>
            &larr; Back
          </button>
          <h1>New Pipeline</h1>
          <p className="subtitle">Agents run in a fixed sequence, passing work down the line.</p>
        </div>
      </div>

      {error && <div className="banner banner-error">{error}</div>}
      {modelsError && <div className="banner banner-error">Could not load models: {modelsError}</div>}

      <div className="card" style={{ maxWidth: 640, marginBottom: 20 }}>
        <div className="field">
          <label>Pipeline Name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Code Review Process" />
        </div>

        <div className="field">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <label style={{ margin: 0 }}>Default model</label>
            <button type="button" className="btn-link" onClick={loadModels}>Refresh</button>
          </div>
          <select value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)}>
            <option value="">Select a model...</option>
            {models.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>

        <div className="section-title" style={{ marginTop: 24, marginBottom: 16 }}>Pipeline Steps</div>
        
        <div className="checkbox-list" style={{ marginBottom: 16 }}>
          <label>
            <input type="checkbox" checked={frame} onChange={(e) => setFrame(e.target.checked)} />
            Start with a framing step (Facilitator)
          </label>
        </div>

        {steps.map((step, idx) => (
          <div key={idx} className="card" style={{ marginBottom: 16, borderLeft: '4px solid var(--border)' }}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
              <strong>Step {idx + 1}</strong>
              <div className="row">
                <button className="btn-link" onClick={() => {
                  const newSteps = [...steps];
                  [newSteps[idx], newSteps[idx - 1]] = [newSteps[idx - 1], newSteps[idx]];
                  setSteps(newSteps);
                }} disabled={idx === 0}>↑</button>
                <button className="btn-link" onClick={() => {
                  const newSteps = [...steps];
                  [newSteps[idx], newSteps[idx + 1]] = [newSteps[idx + 1], newSteps[idx]];
                  setSteps(newSteps);
                }} disabled={idx === steps.length - 1}>↓</button>
                <button className="btn-link" onClick={() => {
                  setSteps(steps.filter((_, i) => i !== idx));
                }}>✕</button>
              </div>
            </div>
            
            <div className="field">
              <label>Role template</label>
              <select value={step.templateId} onChange={(e) => applyTemplate(idx, e.target.value)}>
                <option value="custom">Custom (write your own)</option>
                {roleTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} - {t.description}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label>Role</label>
              <input type="text" value={step.role} onChange={(e) => {
                const newSteps = [...steps];
                newSteps[idx].role = e.target.value;
                setSteps(newSteps);
              }} placeholder="e.g. Security Reviewer" />
            </div>

            <div className="field">
              <label>Instructions</label>
              <textarea value={step.systemPrompt} onChange={(e) => {
                const newSteps = [...steps];
                newSteps[idx].systemPrompt = e.target.value;
                setSteps(newSteps);
              }} rows={3} placeholder="What should this step do?" />
            </div>
          </div>
        ))}

        <button className="btn" onClick={() => setSteps([...steps, { role: '', systemPrompt: '', templateId: 'custom' }])} style={{ marginBottom: 16 }}>
          + Add step
        </button>

        <div className="checkbox-list" style={{ marginBottom: 24 }}>
          <label>
            <input type="checkbox" checked={synth} onChange={(e) => setSynth(e.target.checked)} />
            End with a synthesis step (Facilitator)
          </label>
        </div>

        <button 
          className="btn btn-primary" 
          onClick={createAndPublish} 
          disabled={saving || !name.trim() || !defaultModel || steps.length === 0}
        >
          {saving ? 'Creating...' : 'Create & Publish'}
        </button>
      </div>
    </div>
  );
}
