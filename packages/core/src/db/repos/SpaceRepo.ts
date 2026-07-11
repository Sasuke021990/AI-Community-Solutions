import { Database as SQLiteDatabase } from 'better-sqlite3';
import { Space } from '../../domain/types.js';
import { Strategy, SpaceStatus } from '../../domain/enums.js';
import { validateSpaceForPublish, ValidationIssue } from '../../domain/validation.js';
import { AgentRepo } from './AgentRepo.js';
import { SpaceRow } from '../rows.js';

export class SpaceRepo {
  private agentRepo: AgentRepo;

  constructor(private db: SQLiteDatabase) {
    this.agentRepo = new AgentRepo(db);
  }

  public create(space: Space): void {
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO spaces (id, name, description, strategy, default_model, max_rounds, status, preset_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        space.id, space.name, space.description, space.strategy, space.defaultModel,
        space.maxRounds, space.status, space.presetId ?? null, space.createdAt, space.updatedAt
      );

      if (space.allowedMcpServerIds) {
        this.setAllowedMcpServers(space.id, space.allowedMcpServerIds);
      }
    })();
  }

  public update(space: Space): void {
    const current = this.db.prepare('SELECT * FROM spaces WHERE id = ?').get(space.id) as SpaceRow | undefined;
    if (!current) throw new Error('Space not found');
    if (current.status === SpaceStatus.Published) {
      throw new Error('Cannot edit a published space. Unpublish it first.');
    }
    if (current.preset_id) {
      if (
        space.name !== current.name ||
        space.description !== current.description ||
        space.strategy !== current.strategy
      ) {
        throw new Error("This Space's name, description, and strategy are fixed by its preset and cannot be changed.");
      }
    }

    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE spaces
        SET name = ?, description = ?, strategy = ?, default_model = ?, max_rounds = ?, updated_at = ?
        WHERE id = ?
      `).run(
        space.name, space.description, space.strategy, space.defaultModel, space.maxRounds, space.updatedAt, space.id
      );

      if (space.allowedMcpServerIds) {
        this.setAllowedMcpServers(space.id, space.allowedMcpServerIds);
      }
    })();
  }

  public createFromPreset(space: Space, agents: import('../../domain/types.js').Agent[]): Space {
    if (!space.presetId) throw new Error('createFromPreset requires a presetId');

    const existing = this.db.prepare('SELECT id FROM spaces WHERE preset_id = ?').get(space.presetId);
    if (existing) throw new Error(`A Space for this preset already exists.`);

    return this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO spaces (id, name, description, strategy, default_model, max_rounds, status, preset_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `).run(
        space.id, space.name, space.description, space.strategy, space.defaultModel,
        space.maxRounds, space.status, space.createdAt, space.updatedAt
      );

      for (const agent of agents) {
        this.agentRepo.create(agent);
      }

      this.db.prepare('UPDATE spaces SET preset_id = ? WHERE id = ?').run(space.presetId, space.id);

      return this.get(space.id)!;
    })();
  }

  public delete(id: string): void {
    this.assertNoActiveRun(id, 'delete');
    this.db.prepare('DELETE FROM spaces WHERE id = ?').run(id);
  }

  public publish(id: string): { success: boolean, issues: ValidationIssue[] } {
    const space = this.get(id);
    if (!space) throw new Error('Space not found');
    
    const agents = this.agentRepo.listBySpace(id);
    const issues = validateSpaceForPublish(space, agents);

    if (issues.length > 0) {
      return { success: false, issues };
    }

    this.db.prepare('UPDATE spaces SET status = ?, updated_at = ? WHERE id = ?').run(SpaceStatus.Published, Date.now(), id);
    return { success: true, issues: [] };
  }

  public unpublish(id: string): void {
    this.assertNoActiveRun(id, 'unpublish');
    this.db.prepare('UPDATE spaces SET status = ?, updated_at = ? WHERE id = ?').run(SpaceStatus.Draft, Date.now(), id);
  }

  public get(id: string): Space | null {
    const row = this.db.prepare('SELECT * FROM spaces WHERE id = ?').get(id) as SpaceRow | undefined;
    if (!row) return null;
    return this.mapRowToSpace(row);
  }

  public list(): Space[] {
    const rows = this.db.prepare('SELECT * FROM spaces').all() as SpaceRow[];
    return rows.map(row => this.mapRowToSpace(row));
  }

  private assertNoActiveRun(spaceId: string, action: 'delete' | 'unpublish'): void {
    const active = this.db.prepare("SELECT 1 FROM runs WHERE space_id = ? AND status = 'running'").get(spaceId);
    if (active) {
      throw new Error(`Cannot ${action} a Space while a run is active.`);
    }
  }

  private setAllowedMcpServers(spaceId: string, serverIds: string[]) {
    this.db.prepare('DELETE FROM space_mcp WHERE space_id = ?').run(spaceId);
    const insert = this.db.prepare('INSERT INTO space_mcp (space_id, mcp_server_id) VALUES (?, ?)');
    for (const serverId of serverIds) {
      insert.run(spaceId, serverId);
    }
  }

  private getAllowedMcpServers(spaceId: string): string[] {
    const rows = this.db.prepare('SELECT mcp_server_id FROM space_mcp WHERE space_id = ?').all(spaceId) as { mcp_server_id: string }[];
    return rows.map(r => r.mcp_server_id);
  }

  private mapRowToSpace(row: SpaceRow): Space {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      strategy: row.strategy as Strategy,
      defaultModel: row.default_model,
      maxRounds: row.max_rounds,
      status: row.status as SpaceStatus,
      presetId: row.preset_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      allowedMcpServerIds: this.getAllowedMcpServers(row.id)
    };
  }
}
