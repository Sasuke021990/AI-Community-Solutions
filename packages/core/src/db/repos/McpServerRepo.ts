import { Database as SQLiteDatabase } from 'better-sqlite3';
import { McpServerConfig } from '../../domain/types.js';
import { McpServerRow } from '../rows.js';

export class McpServerRepo {
  constructor(private db: SQLiteDatabase) {}

  public create(config: McpServerConfig): void {
    this.db.prepare(`
      INSERT INTO mcp_servers (id, name, transport, command, args, env, url, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      config.id, config.name, config.transport, config.command || null,
      config.args ? JSON.stringify(config.args) : null,
      config.env ? JSON.stringify(config.env) : null,
      config.url || null, config.enabled ? 1 : 0, config.createdAt
    );
  }

  public update(config: McpServerConfig): void {
    this.db.prepare(`
      UPDATE mcp_servers
      SET name = ?, transport = ?, command = ?, args = ?, env = ?, url = ?, enabled = ?
      WHERE id = ?
    `).run(
      config.name, config.transport, config.command || null,
      config.args ? JSON.stringify(config.args) : null,
      config.env ? JSON.stringify(config.env) : null,
      config.url || null, config.enabled ? 1 : 0, config.id
    );
  }

  public list(): McpServerConfig[] {
    const rows = this.db.prepare('SELECT * FROM mcp_servers').all() as McpServerRow[];
    return rows.map(this.mapRowToConfig);
  }

  public delete(id: string): { success: boolean, affectedSpaces: string[] } {
    const checkStmt = this.db.prepare(`
      SELECT s.name 
      FROM spaces s
      JOIN space_mcp sm ON s.id = sm.space_id
      WHERE sm.mcp_server_id = ? AND s.status = 'published'
    `);
    const affected = checkStmt.all(id) as { name: string }[];
    
    if (affected.length > 0) {
      return { success: false, affectedSpaces: affected.map(r => r.name) };
    }

    this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
    return { success: true, affectedSpaces: [] };
  }

  private mapRowToConfig(row: McpServerRow): McpServerConfig {
    return {
      id: row.id,
      name: row.name,
      transport: row.transport as 'stdio' | 'http',
      command: row.command || undefined,
      args: row.args ? (JSON.parse(row.args) as string[]) : undefined,
      env: row.env ? (JSON.parse(row.env) as Record<string, string>) : undefined,
      url: row.url || undefined,
      enabled: row.enabled === 1,
      createdAt: row.created_at
    };
  }
}
