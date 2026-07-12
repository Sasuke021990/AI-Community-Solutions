import { describe, it, expect } from 'vitest';
import { listSpacePresets } from './spacePresets.js';
import { Strategy } from '../domain/enums.js';
import { validateSpaceForPublish } from '../domain/validation.js';

describe('listSpacePresets', () => {
  it('returns exactly 7 entries with unique ids', () => {
    const presets = listSpacePresets();
    expect(presets).toHaveLength(7);
    const ids = new Set(presets.map((p) => p.id));
    expect(ids.size).toBe(7);
  });

  it('matches the specific agent roster rules', () => {
    const presets = listSpacePresets();

    for (const preset of presets) {
      expect(preset.bestFor.length).toBeGreaterThan(0);
      const orchestrators = preset.agents.filter((a) => a.isOrchestrator);

      if (preset.strategy === Strategy.Orchestrator) {
        expect(orchestrators).toHaveLength(1);
      } else {
        expect(orchestrators).toHaveLength(0);
      }

      for (const agent of preset.agents) {
        expect(agent.systemPrompt.length).toBeGreaterThan(200);
        expect(agent.systemPrompt).not.toMatch(/\{\{.*\}\}/);
      }
    }
  });
  it('passes publish validation for all presets', () => {
    const presets = listSpacePresets();
    for (const preset of presets) {
      const issues = validateSpaceForPublish(preset, preset.agents);
      expect(issues).toEqual([]);
    }
  });

  it('orchestrator prompts do not contain prose delegation examples that conflict with engine task tags', () => {
    const presets = listSpacePresets();
    for (const preset of presets) {
      if (preset.strategy === Strategy.Orchestrator) {
        const orch = preset.agents.find((a) => a.isOrchestrator)!;
        expect(orch.systemPrompt).not.toMatch(/process directions/i);
        expect(orch.systemPrompt).not.toMatch(/Brief process directives/i);
        expect(orch.systemPrompt).not.toMatch(/Brief directives to specific agents and summaries of progress\./i);
      }
    }
  });
});
