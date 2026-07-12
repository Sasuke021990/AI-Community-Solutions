import { describe, it, expect } from 'vitest';
import { validateSpaceForPublish } from './validation.js';
import { Strategy, SpaceStatus } from './enums.js';
import { Space, Agent } from './types.js';

function mkSpace(strategy: Strategy): Space {
  return {
    id: 's1', name: 'S', description: '', strategy, defaultModel: 'm',
    maxRounds: 5, status: SpaceStatus.Draft, createdAt: 0, updatedAt: 0
  };
}

function mkAgent(over: Partial<Agent>): Agent {
  return {
    id: 'a1', spaceId: 's1', name: 'A', role: 'R', systemPrompt: 'sys',
    position: 0, isOrchestrator: false, ...over
  };
}

describe('validateSpaceForPublish', () => {
  it('rejects a Space with zero agents', () => {
    const issues = validateSpaceForPublish(mkSpace(Strategy.RoundRobin), []);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('at least one agent');
  });

  it('Orchestrator strategy: rejects zero orchestrator-flagged agents', () => {
    const agents = [mkAgent({ id: 'a1', isOrchestrator: false })];
    const issues = validateSpaceForPublish(mkSpace(Strategy.Orchestrator), agents);
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe('strategy');
    expect(issues[0].message).toContain('exactly one agent designated');
  });

  it('Orchestrator strategy: rejects more than one orchestrator-flagged agent', () => {
    const agents = [
      mkAgent({ id: 'a1', isOrchestrator: true }),
      mkAgent({ id: 'a2', isOrchestrator: true })
    ];
    const issues = validateSpaceForPublish(mkSpace(Strategy.Orchestrator), agents);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('exactly one agent designated');
  });

  it('Orchestrator strategy: accepts exactly one orchestrator-flagged agent', () => {
    const agents = [
      mkAgent({ id: 'a1', isOrchestrator: true }),
      mkAgent({ id: 'a2', isOrchestrator: false })
    ];
    expect(validateSpaceForPublish(mkSpace(Strategy.Orchestrator), agents)).toEqual([]);
  });

  it('RoundRobin strategy: rejects any agent flagged as orchestrator', () => {
    const agents = [mkAgent({ id: 'a1', isOrchestrator: true })];
    const issues = validateSpaceForPublish(mkSpace(Strategy.RoundRobin), agents);
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe('strategy');
    expect(issues[0].message).toContain('Only the orchestrator strategy');
  });

  it('Debate strategy: rejects any agent flagged as orchestrator', () => {
    const agents = [mkAgent({ id: 'a1', isOrchestrator: true })];
    const issues = validateSpaceForPublish(mkSpace(Strategy.Debate), agents);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('Only the orchestrator strategy');
  });

  it('RoundRobin strategy: accepts agents with no orchestrator flagged', () => {
    const agents = [mkAgent({ id: 'a1', isOrchestrator: false }), mkAgent({ id: 'a2', isOrchestrator: false })];
    expect(validateSpaceForPublish(mkSpace(Strategy.RoundRobin), agents)).toEqual([]);
  });
});
