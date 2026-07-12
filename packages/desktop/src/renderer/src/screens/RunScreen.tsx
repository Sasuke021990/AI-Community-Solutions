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
  const [confirmStop, setConfirmStop] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);

  const confirmStopBtnRef = useRef<HTMLButtonElement>(null);

  const seenEventIds = useRef(new Set<string>());
  const runIdRef = useRef<string | null>(null);
  /** Ephemeral accumulator: agentId -> partial streamed text. NOT React state. */
  const streamingRef = useRef(new Map<string, string>());
  const [streamingVersion, setStreamingVersion] = useState(0);
  const flushPendingRef = useRef(false);
  const [resetScroll, setResetScroll] = useState(false);

  function addEvent(e: RunEvent) {
    if (seenEventIds.current.has(e.id)) return;
    seenEventIds.current.add(e.id);
    // When the final AgentMessage lands, clear the streaming partial for that agent.
    if (e.type === 'agent_message' && e.agentId) {
      streamingRef.current.delete(e.agentId);
    }
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
    const unsubToken = window.acs.runs.onToken(({ runId, agentId, token }) => {
      if (runId !== runIdRef.current) return;
      const cur = streamingRef.current.get(agentId) ?? '';
      streamingRef.current.set(agentId, cur + token);
      // Throttle React re-renders: batch tokens arriving within 50ms into one update.
      if (!flushPendingRef.current) {
        flushPendingRef.current = true;
        setTimeout(() => {
          flushPendingRef.current = false;
          setStreamingVersion((v) => v + 1);
        }, 50);
      }
    });
    const unsubReport = window.acs.runs.onReportGeneration(({ runId, isGenerating }) => {
      if (runId === runIdRef.current) setIsGeneratingPdf(isGenerating);
    });

    setLoading(true);
    seenEventIds.current = new Set();
    setEvents([]);
    setRun(null);
    runIdRef.current = null;
    setConfirmStop(false);
    streamingRef.current = new Map();
    setStreamingVersion(0);
    setResetScroll((v) => !v); // toggle to trigger effect in RunFeed
    Promise.all([loadSpace(), loadLatestRun()]).finally(() => setLoading(false));

    return () => {
      unsubEvent();
      unsubStatus();
      unsubToken();
      unsubReport();
    };
  }, [spaceId]);

  // Auto-focus the confirm button whenever the stop-confirm banner appears.
  useEffect(() => {
    if (confirmStop) confirmStopBtnRef.current?.focus();
  }, [confirmStop]);

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

  /** Clears the finished run from view (nothing is deleted; History keeps it). */
  function newRun() {
    runIdRef.current = null;
    seenEventIds.current = new Set();
    setEvents([]);
    setRun(null);
    setError(null);
    setConfirmStop(false);
    streamingRef.current = new Map();
    setStreamingVersion(0);
    setResetScroll((v) => !v);
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
            {isRunning ? (
              <>
                {confirmStop ? (
                  <div className="banner banner-warning" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px' }}>
                    <span>Stop this run? Progress so far will be saved as a stopped run.</span>
                    <button
                      ref={confirmStopBtnRef}
                      className="btn btn-danger"
                      onClick={async () => { setConfirmStop(false); await stop(); }}
                      disabled={stopping}
                    >
                      {stopping ? 'Stopping...' : 'Confirm stop'}
                    </button>
                    <button className="btn" onClick={() => setConfirmStop(false)}>Cancel</button>
                  </div>
                ) : (
                  <button className="btn btn-danger" onClick={() => setConfirmStop(true)}>
                    Stop
                  </button>
                )}
              </>
            ) : (
              <button className="btn" onClick={newRun} title="Clear this result and start fresh (kept in History)">
                New run
              </button>
            )}
          </div>

          <RunFeed
            events={events}
            agents={agents}
            live={isRunning}
            streamingByAgent={streamingRef.current}
            streamingVersion={streamingVersion}
            resetScroll={resetScroll}
          />

          {run.status === 'completed' && run.finalAnswer && (
            <div className="final-answer">
              <div className="section-title" style={{ marginTop: 0 }}>
                Final answer
              </div>
              <div dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(run.finalAnswer) }} />
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

          {isGeneratingPdf && (
            <div className="banner banner-info" style={{ marginTop: 24, display: 'flex', alignItems: 'center', gap: 10 }}>
              <div className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
              Generating PDF Report (with summary)...
            </div>
          )}

          {run.status !== 'running' && run.pdfPath && !isGeneratingPdf && (
            <div className="row" style={{ marginTop: 24, padding: 16, background: '#f8fafc', borderRadius: 8 }}>
              <div style={{ flex: 1 }}>
                <div className="section-title" style={{ marginTop: 0, marginBottom: 8 }}>
                  Report (PDF)
                </div>
                <div className="row">
                  <button className="btn" onClick={() => call(window.acs.runs.openPdf(run.pdfPath!))}>Open PDF</button>
                  <button className="btn" onClick={() => call(window.acs.runs.showPdfInFolder(run.pdfPath!))}>Show in folder</button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
