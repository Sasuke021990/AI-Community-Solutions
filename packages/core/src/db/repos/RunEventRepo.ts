import { Database as SQLiteDatabase } from 'better-sqlite3';
import { RunEvent } from '../../domain/types.js';

export class RunEventRepo {
  constructor(private db: SQLiteDatabase) {}

  public append(event: RunEvent): void {
    this.db.prepare(`
      INSERT INTO run_events (id, run_id, seq, type, agent_id, payload, at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id, event.runId, event.seq, event.type, event.agentId || null,
      JSON.stringify(event.payload), event.at
    );
  }

  public listByRun(runId: string): RunEvent[] {
    const rows = this.db.prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY seq ASC').all(runId) as any[];
    return rows.map(r => ({
      id: r.id,
      runId: r.run_id,
      seq: r.seq,
      type: r.type,
      agentId: r.agent_id || undefined,
      payload: JSON.parse(r.payload),
      at: r.at
    }));
  }
}
