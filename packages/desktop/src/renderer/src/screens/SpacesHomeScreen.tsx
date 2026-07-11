import { useEffect, useState } from 'react';
import type { Space } from '@acs/core';
import { call } from '../lib/api.js';
import { StatusBadge } from '../components/StatusBadge.js';

interface SpacesHomeScreenProps {
  onOpenBuilder: (spaceId: string | null) => void;
  onOpenRun: (spaceId: string) => void;
}

export function SpacesHomeScreen({ onOpenBuilder, onOpenRun }: SpacesHomeScreenProps) {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Space | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      setSpaces(await call(window.acs.spaces.list()));
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

  async function confirmDeleteNow() {
    if (!confirmDelete) return;
    try {
      await call(window.acs.spaces.delete(confirmDelete.id));
      setConfirmDelete(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      setConfirmDelete(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Spaces</h1>
          <p className="subtitle">Teams of agents that collaborate on a problem until they produce a solution.</p>
        </div>
        <button className="btn btn-primary" onClick={() => onOpenBuilder(null)}>
          New Space
        </button>
      </div>

      {error && <div className="banner banner-error">{error}</div>}

      {confirmDelete && (
        <div className="banner banner-error">
          Delete "{confirmDelete.name}"? This also deletes its runs and history. This cannot be undone.
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn btn-danger" onClick={confirmDeleteNow}>
              Delete permanently
            </button>
            <button className="btn" onClick={() => setConfirmDelete(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="empty-state">Loading...</div>
      ) : spaces.length === 0 ? (
        <div className="empty-state">No Spaces yet. Create one to get started.</div>
      ) : (
        <div className="card-grid">
          {spaces.map((s) => (
            <div key={s.id} className="card card-clickable" onClick={() => (s.status === 'published' ? onOpenRun(s.id) : onOpenBuilder(s.id))}>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                <strong>{s.name}</strong>
                <StatusBadge status={s.status} />
              </div>
              <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 10 }}>{s.description || 'No description'}</div>
              <div className="row">
                <button
                  className="btn-link"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenBuilder(s.id);
                  }}
                >
                  {s.status === 'published' ? 'View' : 'Edit'}
                </button>
                <button
                  className="btn-link"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDelete(s);
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
