import { describe, it, expect } from 'vitest';
import { listSpacePresets } from './spacePresets.js';
import { Strategy } from '../domain/enums.js';

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
});
