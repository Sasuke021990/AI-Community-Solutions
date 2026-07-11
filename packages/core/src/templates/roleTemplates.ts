import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface RoleTemplate {
  id: string;
  name: string;
  description: string;
  systemPromptTemplate: string;
}

let cache: RoleTemplate[] | null = null;

/**
 * Static catalog of starter role templates, bundled with the package (not
 * stored in SQLite - see Decision #20). Selecting a template is a
 * copy-on-create operation: renderRoleTemplate() produces a plain string
 * that the caller stores directly on the agent, with no ongoing reference
 * back to the template.
 */
export function listRoleTemplates(): RoleTemplate[] {
  if (!cache) {
    const raw = readFileSync(join(__dirname, 'roles.json'), 'utf-8');
    cache = JSON.parse(raw) as RoleTemplate[];
  }
  return cache;
}

export function renderRoleTemplate(
  template: RoleTemplate,
  vars: { agentName: string; spaceDescription: string }
): string {
  return template.systemPromptTemplate
    .split('{{agentName}}')
    .join(vars.agentName)
    .split('{{spaceDescription}}')
    .join(vars.spaceDescription || 'this problem');
}
