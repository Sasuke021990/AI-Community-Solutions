import { useEffect, useState } from 'react';
import type { Space, Agent, Run, RunEvent } from '@acs/core';
import { call } from '../lib/api.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { RunFeed } from '../components/RunFeed.js';
import { renderSafeMarkdown } from '../lib/markdown.js';

interface RunHistoryScreenProps {
  spaceId: string;
  onBack: () => void;
}

export function RunHistoryScreen({ spaceId, onBack }: RunHistoryScreenProps) {
  const [space, setSpace] = useState<Space | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [openEvents, setOpenEvents] = useState<RunEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      call(window.acs.spaces.get(spaceId)),
      call(window.acs.agents.listBySpace(spaceId)),
      call(window.acs.runs.listBySpace(spaceId))
    ])
      .then(([s, a, r]) => {
        setSpace(s);
        setAgents(a);
        setRuns(r);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [spaceId]);

  async function toggleRun(run: Run) {
    if (openRunId === run.id) {
      setOpenRunId(null);
      return;
    }
    setOpenRunId(run.id);
    setLoadingEvents(true);
    try {
      setOpenEvents(await call(window.acs.runs.events(run.id)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingEvents(false);
    }
  }

  if (loading) return <div className="empty-state">Loading...</div>;
  if (!space) return <div className="empty-state">{error ?? 'Space not found.'}</div>;

  return (
    <div>
      <div className="page-header">
        <div>
          <button className="btn-link" onClick={onBack} style={{ paddingLeft: 0 }}>
            &larr; Spaces
          </button>
          <h1>{space.name} - History</h1>
        </div>
      </div>

      {error && <div className="banner banner-error">{error}</div>}

      {runs.length === 0 ? (
        <div className="empty-state">No runs yet for this Space.</div>
      ) : (
        <div>
          {runs.map((run) => (
            <div key={run.id} className="card" style={{ marginBottom: 10 }}>
              <div className="row card-clickable" style={{ justifyContent: 'space-between' }} onClick={() => toggleRun(run)}>
                <div>
                  <StatusBadge status={run.status} /> <span style={{ marginLeft: 8 }}>{run.problem}</span>
                </div>
                <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>
                  {new Date(run.startedAt).toLocaleString()} · {run.roundsUsed} round(s)
                </div>
              </div>

              {openRunId === run.id && (
                <div style={{ marginTop: 12 }}>
                  {loadingEvents ? (
                    <div className="empty-state">Loading transcript...</div>
                  ) : (
                    <>
                      <RunFeed events={openEvents} agents={agents} />
                      {run.finalAnswer && (
                        <div className="final-answer">
                          <div className="section-title" style={{ marginTop: 0 }}>
                            Final answer
                          </div>
                          <div dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(run.finalAnswer) }} />
                        </div>
                      )}
                      {run.error && <div className="banner banner-error">{run.error}</div>}
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
