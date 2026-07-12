import { useEffect, useState } from 'react';
import type { PresetWithStatus } from '../../../preload/index.js';
import { call } from '../lib/api.js';

interface PresetGalleryScreenProps {
  onBack: () => void;
  onOpenBuilder: (spaceId: string) => void;
}

export function PresetGalleryScreen({ onBack, onOpenBuilder }: PresetGalleryScreenProps) {
  const [presets, setPresets] = useState<PresetWithStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        setPresets(await call(window.acs.presets.list()));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  async function handleCreate(presetId: string) {
    setCreating(presetId);
    setError(null);
    try {
      const space = await call(window.acs.presets.createFromPreset(presetId));
      onOpenBuilder(space.id);
    } catch (e) {
      setError((e as Error).message);
      setCreating(null);
    }
  }

  if (loading) return <div className="empty-state">Loading presets...</div>;

  return (
    <div>
      <div className="page-header">
        <div>
          <button className="btn-link" onClick={onBack} style={{ paddingLeft: 0 }}>
            &larr; Spaces
          </button>
          <h1>Preset Gallery</h1>
          <p className="subtitle">Ready-to-use Spaces for common workflows. Just add your problem and run.</p>
        </div>
      </div>

      {error && <div className="banner banner-error">{error}</div>}

      <div className="card-grid">
        {presets.map((preset) => (
          <div key={preset.id} className="card">
            <div style={{ marginBottom: 16 }}>
              <strong>{preset.name}</strong>
              <div style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 4 }}>
                {preset.description}
              </div>
            </div>
            
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 16 }}>
              <div>Strategy: {preset.strategy}</div>
              <div>Agents: {preset.agents.length}</div>
            </div>

            <div style={{ fontSize: 12, marginBottom: 16 }}>
              <span style={{ color: 'var(--text-dim)' }}>Best for: </span>
              {preset.bestFor}
            </div>

            {preset.existingSpaceId ? (
              <button
                className="btn"
                style={{ width: '100%' }}
                onClick={() => onOpenBuilder(preset.existingSpaceId!)}
              >
                Go to Space
              </button>
            ) : (
              <button
                className="btn btn-primary"
                style={{ width: '100%' }}
                onClick={() => handleCreate(preset.id)}
                disabled={creating !== null}
              >
                {creating === preset.id ? 'Creating...' : 'Create Space'}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
