import { describe, it, expect } from 'vitest';
import { listRoleTemplates, renderRoleTemplate } from './roleTemplates.js';

describe('listRoleTemplates', () => {
  it('returns between 6 and 8 templates with unique ids', () => {
    const templates = listRoleTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(6);
    expect(templates.length).toBeLessThanOrEqual(8);
    expect(new Set(templates.map((t) => t.id)).size).toBe(templates.length);
    for (const t of templates) {
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.systemPromptTemplate).toContain('{{agentName}}');
    }
  });
});

describe('renderRoleTemplate', () => {
  it('substitutes agentName and spaceDescription with no leftover placeholders', () => {
    const [template] = listRoleTemplates();
    const rendered = renderRoleTemplate(template, { agentName: 'Ada', spaceDescription: 'ship a widget' });
    expect(rendered).toContain('Ada');
    expect(rendered).toContain('ship a widget');
    expect(rendered).not.toMatch(/\{\{.*?\}\}/);
  });

  it('falls back to a generic phrase when spaceDescription is empty', () => {
    const [template] = listRoleTemplates();
    const rendered = renderRoleTemplate(template, { agentName: 'Ada', spaceDescription: '' });
    expect(rendered).not.toMatch(/\{\{.*?\}\}/);
    expect(rendered.length).toBeGreaterThan(0);
  });

  it('is a pure copy: rendering twice never mutates the source template', () => {
    const [template] = listRoleTemplates();
    const before = template.systemPromptTemplate;
    renderRoleTemplate(template, { agentName: 'X', spaceDescription: 'Y' });
    expect(template.systemPromptTemplate).toBe(before);
  });
});
