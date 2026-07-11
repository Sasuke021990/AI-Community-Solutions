import { useEffect, useRef, useState } from 'react';
import type { Space, Agent, Run, RunEvent, PersistedRunEvent } from '@acs/core';
import { call } from '../lib/api.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { RunFeed } from '../components/RunFeed.js';
import { renderSafeMarkdown } from '../lib/markdown.js';

interface RunScreenProps {
  spaceId: string;
  onOpenHistory: (spaceId: string) => void;
  onBack: () => void;
}

export function RunScreen({ spaceId, onOpenHistory, onBack }: RunScreenProps) {
  const [space, setSpace] = useState<Space | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [problem, setProblem] = useState('');
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const seenEventIds = useRef(new Set<string>());
  const runIdRef = useRef<string | null>(null);

  function addEvent(e: RunEvent) {
    if (seenEventIds.current.has(e.id)) return;
    seenEventIds.current.add(e.id);
    setEvents((prev) => [...prev, e].sort((a, b) => a.seq - b.seq));
  }

  async function loadSpace() {
    try {
      const [s, a] = await Promise.all([call(window.acs.spaces.get(spaceId)), call(window.acs.agents.listBySpace(spaceId))]);
      setSpace(s);
      setAgents(a);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function loadLatestRun() {
    try {
      const runs = await call(window.acs.runs.listBySpace(spaceId));
      const latest = runs[0] ?? null;
      if (latest) {
        runIdRef.current = latest.id;
        setRun(latest);
        const evs = await call(window.acs.runs.events(latest.id));
        for (const e of evs) addEvent(e);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    // Subscribe before the initial fetch to avoid missing events fired in the gap.
    const unsubEvent = window.acs.runs.onEvent((e: PersistedRunEvent) => {
      if (e.runId === runIdRef.current) addEvent(e);
    });
    const unsubStatus = window.acs.runs.onStatus((r: Run) => {
      if (r.id === runIdRef.current) setRun(r);
    });

    setLoading(true);
    seenEventIds.current = new Set();
    setEvents([]);
    setRun(null);
    runIdRef.current = null;
    Promise.all([loadSpace(), loadLatestRun()]).finally(() => setLoading(false));

    return () => {
      unsubEvent();
      unsubStatus();
    };
  }, [spaceId]);

  async function start() {
    if (!problem.trim()) return;
    setStarting(true);
    setError(null);
    try {
      const { runId } = await call(window.acs.runs.start(spaceId, problem.trim()));
      runIdRef.current = runId;
      seenEventIds.current = new Set();
      setEvents([]);
      setProblem('');
      const r = await call(window.acs.runs.get(runId));
      setRun(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  async function stop() {
    if (!run) return;
    setStopping(true);
    try {
      await call(window.acs.runs.stop(run.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStopping(false);
    }
  }

  if (loading) return <div className="empty-state">Loading...</div>;
  if (!space) return <div className="empty-state">{error ?? 'Space not found.'}</div>;

  const isRunning = run?.status === 'running';
  const isBusy = !!run && isRunning;

  return (
    <div>
      <div className="page-header">
        <div>
          <button className="btn-link" onClick={onBack} style={{ paddingLeft: 0 }}>
            &larr; Spaces
          </button>
          <h1>{space.name}</h1>
        </div>
        <button className="btn" onClick={() => onOpenHistory(spaceId)}>
          History
        </button>
      </div>

      {error && <div className="banner banner-error">{error}</div>}

      {!isBusy && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="field">
            <label>Problem</label>
            <textarea
              value={problem}
              onChange={(e) => setProblem(e.target.value)}
              rows={4}
              placeholder="Describe the problem for this Space to solve..."
            />
          </div>
          <button className="btn btn-primary" onClick={start} disabled={starting || !problem.trim()}>
            {starting ? 'Starting...' : 'Start'}
          </button>
        </div>
      )}

      {run && (
        <>
          <div className="row" style={{ marginBottom: 12, justifyContent: 'space-between' }}>
            <div className="row">
              <StatusBadge status={run.status} />
              <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>{run.problem}</span>
            </div>
            {isRunning && (
              <button className="btn btn-danger" onClick={stop} disabled={stopping}>
                {stopping ? 'Stopping...' : 'Stop'}
              </button>
            )}
          </div>

          <RunFeed events={events} agents={agents} live={isRunning} />

          {run.status === 'completed' && run.finalAnswer && (
            <div className="final-answer">
              <div className="section-title" style={{ marginTop: 0 }}>
                Final answer
              </div>
              <div dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(run.finalAnswer) }} />
              <div className="row" style={{ marginTop: 12 }}>
                {run.pdfPath ? (
                  <span className="field-hint">PDF saved to: {run.pdfPath}</span>
                ) : (
                  <span className="field-hint">PDF report generation is not available yet.</span>
                )}
              </div>
            </div>
          )}

          {run.status === 'failed' && (
            <div className="banner banner-error" style={{ marginTop: 16 }}>
              Run failed: {run.error}
            </div>
          )}

          {run.status === 'stopped' && (
            <div className="banner banner-info" style={{ marginTop: 16 }}>
              Run stopped. Partial transcript above.
            </div>
          )}
        </>
      )}
    </div>
  );
}
