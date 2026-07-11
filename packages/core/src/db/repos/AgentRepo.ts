import { Database as SQLiteDatabase } from 'better-sqlite3';
import { Agent } from '../../domain/types.js';
import { AgentRow } from '../rows.js';

export class AgentRepo {
  constructor(private db: SQLiteDatabase) {}

  public create(agent: Agent): void {
    const lock = this.getSpaceLock(agent.spaceId);
    if (lock.published) throw new Error('Cannot modify agents when Space is published.');
    if (lock.presetId) throw new Error("This Space's agent lineup is fixed by its preset and cannot be changed.");
    this.db.prepare(`
      INSERT INTO agents (id, space_id, name, role, system_prompt, model_id, is_orchestrator, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      agent.id, agent.spaceId, agent.name, agent.role, agent.systemPrompt,
      agent.modelId || null, agent.isOrchestrator ? 1 : 0, agent.position
    );
  }

  public update(agent: Agent): void {
    const lock = this.getSpaceLock(agent.spaceId);
    if (lock.published) throw new Error('Cannot modify agents when Space is published.');
    if (lock.presetId) {
      const current = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(agent.id) as AgentRow | undefined;
      if (!current) throw new Error('Agent not found');
      if (
        agent.name !== current.name ||
        agent.role !== current.role ||
        agent.isOrchestrator !== (current.is_orchestrator === 1) ||
        agent.position !== current.position
      ) {
        throw new Error(
          "This agent's name, role, position, and orchestrator status are fixed by the Space's preset " +
          "- only its model and system prompt can be changed."
        );
      }
    }
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
    const lock = this.getSpaceLock(spaceId);
    if (lock.published) throw new Error('Cannot modify agents when Space is published.');
    if (lock.presetId) throw new Error("This Space's agent lineup is fixed by its preset and cannot be changed.");
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  }

  public listBySpace(spaceId: string): Agent[] {
    const rows = this.db.prepare('SELECT * FROM agents WHERE space_id = ? ORDER BY position ASC').all(spaceId) as AgentRow[];
    return rows.map(this.mapRowToAgent);
  }

  private getSpaceLock(spaceId: string): { published: boolean; presetId: string | null } {
    const space = this.db
      .prepare('SELECT status, preset_id FROM spaces WHERE id = ?')
      .get(spaceId) as { status: string; preset_id: string | null } | undefined;
    return { published: space?.status === 'published', presetId: space?.preset_id ?? null };
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
