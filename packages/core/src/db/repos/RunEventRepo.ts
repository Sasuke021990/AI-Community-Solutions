import { Database as SQLiteDatabase } from 'better-sqlite3';
import { RunEvent } from '../../domain/types.js';
import { RunEventType } from '../../domain/enums.js';
import { RunEventRow } from '../rows.js';

export class RunEventRepo {
  constructor(private db: SQLiteDatabase) {}

  /** Appends an event, auto-assigning the next per-run sequence number. Returns the stored event. */
  public append(event: Omit<RunEvent, 'seq'>): RunEvent {
    return this.db.transaction(() => {
      const { next } = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_events WHERE run_id = ?')
        .get(event.runId) as { next: number };

      this.db.prepare(`
        INSERT INTO run_events (id, run_id, seq, type, agent_id, payload, at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id, event.runId, next, event.type, event.agentId || null,
        JSON.stringify(event.payload), event.at
      );

      return { ...event, seq: next };
    })();
  }

  public listByRun(runId: string): RunEvent[] {
    const rows = this.db.prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY seq ASC').all(runId) as RunEventRow[];
    return rows.map(r => ({
      id: r.id,
      runId: r.run_id,
      seq: r.seq,
      type: r.type as RunEventType,
      agentId: r.agent_id || undefined,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
      at: r.at
    }));
  }
}
