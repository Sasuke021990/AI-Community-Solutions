import { describe, it, expect } from 'vitest';
import { listRoleTemplates } from './roleTemplates.js';

describe('listRoleTemplates', () => {
  it('returns at least the starter set, all with unique ids and required fields', () => {
    const templates = listRoleTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(6);
    expect(new Set(templates.map((t) => t.id)).size).toBe(templates.length);
    for (const t of templates) {
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.systemPrompt.length).toBeGreaterThan(200); // professional-grade, not a one-liner
    }
  });

  it('prompts are generic: no template placeholders remain', () => {
    for (const t of listRoleTemplates()) {
      expect(t.systemPrompt).not.toMatch(/\{\{.*?\}\}/);
    }
  });

  it('includes the full Six Thinking Hats set', () => {
    const ids = listRoleTemplates().map((t) => t.id);
    for (const hat of ['white-hat', 'red-hat', 'black-hat', 'yellow-hat', 'green-hat', 'blue-hat']) {
      expect(ids).toContain(hat);
    }
  });
});
