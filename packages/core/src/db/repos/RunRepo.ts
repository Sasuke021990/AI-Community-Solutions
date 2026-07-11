import { Database as SQLiteDatabase } from 'better-sqlite3';
import { Run } from '../../domain/types.js';
import { RunStatus } from '../../domain/enums.js';

export class RunRepo {
  constructor(private db: SQLiteDatabase) {}

  public create(run: Run): void {
    const active = this.db.prepare('SELECT id FROM runs WHERE space_id = ? AND status = ?').get(run.spaceId, RunStatus.Running);
    if (active) {
      throw new Error('A run is already active for this Space.');
    }

    this.db.prepare(`
      INSERT INTO runs (id, space_id, problem, status, rounds_used, final_answer, pdf_path, error, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id, run.spaceId, run.problem, run.status, run.roundsUsed, run.finalAnswer || null,
      run.pdfPath || null, run.error || null, run.startedAt, run.finishedAt || null
    );
  }

  public updateStatus(id: string, status: RunStatus, finishedAt?: number, error?: string): void {
    this.db.prepare(`
      UPDATE runs SET status = ?, finished_at = ?, error = ? WHERE id = ?
    `).run(status, finishedAt || null, error || null, id);
  }

  public completeRun(id: string, finalAnswer: string, pdfPath?: string): void {
    this.db.prepare(`
      UPDATE runs SET status = ?, final_answer = ?, pdf_path = ?, finished_at = ? WHERE id = ?
    `).run(RunStatus.Completed, finalAnswer, pdfPath || null, Date.now(), id);
  }

  public incrementRounds(id: string): void {
    this.db.prepare('UPDATE runs SET rounds_used = rounds_used + 1 WHERE id = ?').run(id);
  }

  public markInterrupted(): void {
    this.db.prepare(`
      UPDATE runs SET status = ?, error = ?, finished_at = ? WHERE status = ?
    `).run(RunStatus.Failed, 'interrupted', Date.now(), RunStatus.Running);
  }

  public get(id: string): Run | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      spaceId: row.space_id,
      problem: row.problem,
      status: row.status,
      roundsUsed: row.rounds_used,
      finalAnswer: row.final_answer || undefined,
      pdfPath: row.pdf_path || undefined,
      error: row.error || undefined,
      startedAt: row.started_at,
      finishedAt: row.finished_at || undefined
    };
  }
}
