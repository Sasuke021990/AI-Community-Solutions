import { Database as SQLiteDatabase } from 'better-sqlite3';
import { WebhookConfig } from '../../domain/types.js';
import { WebhookRow } from '../rows.js';

export class WebhookRepo {
  constructor(private db: SQLiteDatabase) {}

  public create(w: WebhookConfig): void {
    this.db.prepare(`
      INSERT INTO webhooks (id, name, description, method, url, parameterized, headers, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      w.id, w.name, w.description, w.method, w.url, w.parameterized ? 1 : 0,
      w.headers ? JSON.stringify(w.headers) : null, w.enabled ? 1 : 0, w.createdAt
    );
  }

  public update(w: WebhookConfig): void {
    this.db.prepare(`
      UPDATE webhooks
      SET name = ?, description = ?, method = ?, url = ?, parameterized = ?, headers = ?, enabled = ?
      WHERE id = ?
    `).run(
      w.name, w.description, w.method, w.url, w.parameterized ? 1 : 0,
      w.headers ? JSON.stringify(w.headers) : null, w.enabled ? 1 : 0, w.id
    );
  }

  public list(): WebhookConfig[] {
    const rows = this.db.prepare('SELECT * FROM webhooks').all() as WebhookRow[];
    return rows.map(this.mapRow);
  }

  public delete(id: string): { success: boolean; affectedSpaces: string[] } {
    const affected = this.db.prepare(`
      SELECT s.name FROM spaces s
      JOIN space_webhooks sw ON s.id = sw.space_id
      WHERE sw.webhook_id = ? AND s.status = 'published'
    `).all(id) as { name: string }[];
    if (affected.length > 0) return { success: false, affectedSpaces: affected.map((r) => r.name) };
    this.db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
    return { success: true, affectedSpaces: [] };
  }

  private mapRow(row: WebhookRow): WebhookConfig {
    return {
      id: row.id, name: row.name, description: row.description,
      method: row.method as 'GET' | 'POST', url: row.url,
      parameterized: row.parameterized === 1,
      headers: row.headers ? (JSON.parse(row.headers) as Record<string, string>) : undefined,
      enabled: row.enabled === 1, createdAt: row.created_at
    };
  }
}
