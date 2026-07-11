import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface RoleTemplate {
  id: string;
  name: string;
  description: string;
  /**
   * A complete, generic system prompt for the role. No placeholders: agent
   * identity is injected at run time by the engine (AgentCaller), so the
   * stored prompt is purely about the role.
   */
  systemPrompt: string;
}

let cache: RoleTemplate[] | null = null;

/**
 * Static catalog of starter role templates, bundled with the package (not
 * stored in SQLite - see Decision #20). Selecting a template is a
 * copy-on-create operation: the caller copies systemPrompt onto the agent,
 * with no ongoing reference back to the template.
 */
export function listRoleTemplates(): RoleTemplate[] {
  if (!cache) {
    const raw = readFileSync(join(__dirname, 'roles.json'), 'utf-8');
    cache = JSON.parse(raw) as RoleTemplate[];
  }
  return cache;
}
