import type { RunEvent, Agent } from '@acs/core';
import { renderSafeMarkdown } from '../lib/markdown.js';

interface RunFeedProps {
  events: RunEvent[];
  agents: Agent[];
  /** True while the run is still active, so an in-flight turn can show a pending indicator. */
  live?: boolean;
}

interface ChatMessagePayload {
  role: string;
  content: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
}

interface Turn {
  agentId?: string;
  model?: string;
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
      const payload = e.payload as { model?: string };
      const turn: Turn = { agentId: e.agentId, model: payload.model, toolCalls: [] };
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

export function RunFeed({ events, agents, live }: RunFeedProps) {
  const items = buildFeed(events);
  const agentName = (id?: string) => (id ? (agents.find((a) => a.id === id)?.name ?? 'Unknown agent') : 'System');

  if (items.length === 0) {
    return <div className="empty-state">No activity yet.</div>;
  }

  return (
    <div className="feed">
      {items.map((item) =>
        item.kind === 'system' ? (
          <div key={item.seq} className="feed-system">
            {item.note}
          </div>
        ) : (
          <div key={item.seq} className="feed-turn">
            <div className="feed-turn-header">
              <span className="agent-dot" />
              <strong>{agentName(item.turn!.agentId)}</strong>
              {item.turn!.model && <span>· {item.turn!.model}</span>}
              {live && !item.turn!.message && <span className="loading-dots">thinking</span>}
            </div>
            {item.turn!.message && (
              <div
                className="feed-turn-body"
                dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(item.turn!.message.content) }}
              />
            )}
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
        )
      )}
    </div>
  );
}
