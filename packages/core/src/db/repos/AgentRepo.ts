import { Database as SQLiteDatabase } from 'better-sqlite3';
import { Agent } from '../../domain/types.js';
import { AgentRow } from '../rows.js';

export class AgentRepo {
  constructor(private db: SQLiteDatabase) {}

  public create(agent: Agent): void {
    this.assertSpaceDraft(agent.spaceId);
    this.db.prepare(`
      INSERT INTO agents (id, space_id, name, role, system_prompt, model_id, is_orchestrator, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      agent.id, agent.spaceId, agent.name, agent.role, agent.systemPrompt,
      agent.modelId || null, agent.isOrchestrator ? 1 : 0, agent.position
    );
  }

  public update(agent: Agent): void {
    this.assertSpaceDraft(agent.spaceId);
    this.db.prepare(`
      UPDATE agents
      SET name = ?, role = ?, system_prompt = ?, model_id = ?, is_orchestrator = ?, position = ?
      WHERE id = ?
    `).run(
      agent.name, agent.role, agent.systemPrompt, agent.modelId || null,
      agent.isOrchestrator ? 1 : 0, agent.position, agent.id
    );
  }

  public delete(id: string, spaceId: string): void {
    this.assertSpaceDraft(spaceId);
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  }

  public listBySpace(spaceId: string): Agent[] {
    const rows = this.db.prepare('SELECT * FROM agents WHERE space_id = ? ORDER BY position ASC').all(spaceId) as AgentRow[];
    return rows.map(this.mapRowToAgent);
  }

  private assertSpaceDraft(spaceId: string): void {
    const space = this.db.prepare('SELECT status FROM spaces WHERE id = ?').get(spaceId) as { status: string } | undefined;
    if (space && space.status === 'published') {
      throw new Error('Cannot modify agents when Space is published.');
    }
  }

  private mapRowToAgent(row: AgentRow): Agent {
    return {
      id: row.id,
      spaceId: row.space_id,
      name: row.name,
      role: row.role,
      systemPrompt: row.system_prompt,
      modelId: row.model_id || undefined,
      isOrchestrator: row.is_orchestrator === 1,
      position: row.position
    };
  }
}
