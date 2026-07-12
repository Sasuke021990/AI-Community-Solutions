import type { RunEvent, Agent } from '@acs/core';
import { useEffect, useRef, useState } from 'react';
import { renderSafeMarkdown } from '../lib/markdown.js';

interface RunFeedProps {
  events: RunEvent[];
  agents: Agent[];
  /** True while the run is still active, so an in-flight turn can show a pending indicator. */
  live?: boolean;
  /** Ephemeral per-agent streaming text (never persisted). Cleared when AgentMessage lands. */
  streamingByAgent?: Map<string, string>;
  /** Bumped by parent after each throttled token flush to trigger re-render. */
  streamingVersion?: number;
  /** When true, resets auto-scroll to bottom (e.g. new run started). */
  resetScroll?: boolean;
}

interface ChatMessagePayload {
  role: string;
  content: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
}

interface Turn {
  agentId?: string;
  model?: string;
  phase?: string;
  cycle?: number;
  totalCycles?: number;
  message?: ChatMessagePayload;
  toolCalls: { id: string; name: string; args: string; result?: string }[];
}

interface FeedItem {
  kind: 'turn' | 'system';
  turn?: Turn;
  note?: string;
  seq: number;
}

function buildFeed(events: RunEvent[]): FeedItem[] {
  const items: FeedItem[] = [];
  const turnByAgent = new Map<string, Turn>();

  for (const e of events) {
    if (e.type === 'round_start') {
      const payload = e.payload as { model?: string; phase?: string; cycle?: number; totalCycles?: number };
      const turn: Turn = { 
        agentId: e.agentId, model: payload.model, 
        phase: payload.phase, cycle: payload.cycle, totalCycles: payload.totalCycles, 
        toolCalls: [] 
      };
      if (e.agentId) turnByAgent.set(e.agentId, turn);
      items.push({ kind: 'turn', turn, seq: e.seq });
    } else if (e.type === 'agent_message') {
      const payload = e.payload as { message: ChatMessagePayload };
      const turn = e.agentId ? turnByAgent.get(e.agentId) : undefined;
      if (turn) {
        turn.message = payload.message;
      } else {
        items.push({ kind: 'turn', turn: { agentId: e.agentId, message: payload.message, toolCalls: [] }, seq: e.seq });
      }
    } else if (e.type === 'tool_call') {
      const payload = e.payload as { toolCall: { id: string; function: { name: string; arguments: string } } };
      const turn = e.agentId ? turnByAgent.get(e.agentId) : undefined;
      if (turn) turn.toolCalls.push({ id: payload.toolCall.id, name: payload.toolCall.function.name, args: payload.toolCall.function.arguments });
    } else if (e.type === 'tool_result') {
      const payload = e.payload as { toolCallId: string; result: string };
      const turn = e.agentId ? turnByAgent.get(e.agentId) : undefined;
      const tc = turn?.toolCalls.find((t) => t.id === payload.toolCallId);
      if (tc) tc.result = payload.result;
    } else if (e.type === 'system') {
      const payload = e.payload as { note?: string; error?: string };
      items.push({ kind: 'system', note: payload.note ?? payload.error ?? JSON.stringify(payload), seq: e.seq });
    }
  }

  return items;
}

const SCROLL_THRESHOLD = 40; // px from bottom considered "at bottom"

export function RunFeed({ events, agents, live, streamingByAgent, streamingVersion, resetScroll }: RunFeedProps) {
  const items = buildFeed(events);
  const agentName = (id?: string) => (id ? (agents.find((a) => a.id === id)?.name ?? 'Unknown agent') : 'System');

  const panelRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Reset auto-scroll when parent signals a new run.
  useEffect(() => {
    if (resetScroll) setAutoScroll(true);
  }, [resetScroll]);

  // Scroll to bottom when auto-scroll is enabled and content changes.
  useEffect(() => {
    if (autoScroll && panelRef.current) {
      panelRef.current.scrollTop = panelRef.current.scrollHeight;
    }
  }, [events.length, streamingVersion, autoScroll]);

  function handleScroll() {
    const el = panelRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD;
    setAutoScroll(atBottom);
  }

  function jumpToLatest() {
    if (panelRef.current) {
      panelRef.current.scrollTop = panelRef.current.scrollHeight;
    }
    setAutoScroll(true);
  }

  if (items.length === 0) {
    return <div className="empty-state">No activity yet.</div>;
  }

  return (
    <div className="run-feed-panel" ref={panelRef} onScroll={handleScroll}>
      <div className="feed">
        {items.map((item) =>
          item.kind === 'system' ? (
            <div key={item.seq} className="feed-system">
              {item.note}
            </div>
          ) : (() => {
            const agentId = item.turn!.agentId;
            const streaming = agentId ? streamingByAgent?.get(agentId) : undefined;
            const isStreaming = live && !item.turn!.message && !!streaming;
            return (
              <div key={item.seq} className={`feed-turn${isStreaming ? ' is-streaming' : ''}`}>
                <div className="feed-turn-header">
                  <span className="agent-dot" />
                  <strong>{agentName(agentId)}</strong>
                  {item.turn!.totalCycles && item.turn!.totalCycles > 1 && (
                    <span>· Cycle {item.turn!.cycle}/{item.turn!.totalCycles} · {item.turn!.phase}</span>
                  )}
                  {item.turn!.model && <span>· {item.turn!.model}</span>}
                  {live && !item.turn!.message && !streaming && <span className="loading-dots">thinking</span>}
                </div>
                {item.turn!.message && (
                  <div
                    className="feed-turn-body"
                    dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(item.turn!.message.content) }}
                  />
                )}
                {streaming && !item.turn!.message && (
                  <div
                    className="feed-turn-body"
                    dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(streaming) }}
                  />
                )}
                {streaming && !item.turn!.message && <span className="typing-cursor" aria-hidden="true" />}
                {item.turn!.toolCalls.map((tc) => (
                  <details key={tc.id} className="feed-tool">
                    <summary>
                      Tool: {tc.name} {tc.result === undefined ? '(running...)' : ''}
                    </summary>
                    <pre>{tc.args}</pre>
                    {tc.result !== undefined && <pre>{tc.result}</pre>}
                  </details>
                ))}
              </div>
            );
          })()
        )}
      </div>
      {!autoScroll && (
        <button className="jump-latest" onClick={jumpToLatest} aria-label="Jump to latest">
          ↓ Jump to latest
        </button>
      )}
    </div>
  );
}


