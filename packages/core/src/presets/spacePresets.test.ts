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

      if (preset.strategy === Strategy.Orchestrator || preset.strategy === Strategy.Structured) {
        expect(orchestrators.length).toBeLessThanOrEqual(1);
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

  it('no preset uses the retired Orchestrator strategy (all converted to structured)', () => {
    const presets = listSpacePresets();
    for (const preset of presets) {
      expect(preset.strategy).not.toBe(Strategy.Orchestrator);
    }
  });

  it('structured framer prompts do not describe real-time delegation the engine no longer performs', () => {
    // Regression guard: a structured framer speaks exactly twice (open, then
    // synthesize) - it never sees a hat's output mid-session and can't
    // "decide who's next" or "ask X to do Y", since the code (not the
    // framer) drives the sequence. A prompt that still describes live
    // delegation misleads the model about what it can actually do.
    const presets = listSpacePresets();
    for (const preset of presets) {
      const framer = preset.agents.find((a) => a.isOrchestrator);
      if (!framer) continue;
      expect(framer.systemPrompt).not.toMatch(/decide which .*(is needed next|goes next)/i);
      expect(framer.systemPrompt).not.toMatch(/task them explicitly/i);
      expect(framer.systemPrompt).not.toMatch(/^(ask|delegate) the .*(to|closing)/im);
      expect(framer.systemPrompt).not.toMatch(/repeat until/i);
    }
  });

  it('maxRounds=1 for every single-pass linear preset (no framer-with-repeat presets exist)', () => {
    // Regression guard for the specific bug found in review: a linear
    // preset (one pass through all workers, optionally framed/synthesized)
    // left at a stale maxRounds > 1 silently re-runs the WHOLE worker
    // sequence that many times under StructuredStrategy's cycle loop.
    const LINEAR_SINGLE_PASS = ['six-thinking-hats', 'triz', 'means-end-analysis', 'design-thinking', 'the-core-framework'];
    const presets = listSpacePresets();
    for (const id of LINEAR_SINGLE_PASS) {
      const preset = presets.find((p) => p.id === id)!;
      expect(preset.maxRounds).toBe(1);
    }
  });
});
