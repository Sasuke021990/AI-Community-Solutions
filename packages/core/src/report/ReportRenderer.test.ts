import { describe, it, expect } from 'vitest';
import { renderRunReport } from './ReportRenderer.js';
import { RunStatus, RunEventType, Strategy, SpaceStatus } from '../domain/enums.js';
import { Run, Space, Agent, RunEvent } from '../domain/types.js';

describe('ReportRenderer', () => {
  const space: Space = { id: 's1', name: 'Test Space', description: '', strategy: Strategy.RoundRobin, defaultModel: 'm', maxRounds: 5, status: SpaceStatus.Published, createdAt: 0, updatedAt: 0 };
  const agents: Agent[] = [
    { id: 'a1', spaceId: 's1', name: 'Agent 1', role: 'Detective', systemPrompt: '', position: 1, isOrchestrator: false },
    { id: 'a2', spaceId: 's1', name: 'Boss', role: 'Chief', systemPrompt: '', position: 0, isOrchestrator: true }
  ];

  it('renders a completed run with cover and body correctly', () => {
    const run: Run = { id: 'r1', spaceId: 's1', problem: 'Find the cat', status: RunStatus.Completed, roundsUsed: 1, startedAt: 1000, finalAnswer: '**Found it**' };
    const events: RunEvent[] = [
      { id: 'e1', runId: 'r1', type: RunEventType.RoundStart, agentId: 'a2', payload: { model: 'm' }, at: 1010, seq: 1 },
      { id: 'e2', runId: 'r1', type: RunEventType.AgentMessage, agentId: 'a2', payload: { message: { role: 'assistant', content: 'I am assigning tasks.' } }, at: 1020, seq: 2 },
      { id: 'e3', runId: 'r1', type: RunEventType.ToolCall, agentId: 'a2', payload: { toolCall: { id: 't1', type: 'function', function: { name: 'search', arguments: '{"q":"cat"}' } } }, at: 1030, seq: 3 },
      { id: 'e4', runId: 'r1', type: RunEventType.System, payload: { note: 'System intervened' }, at: 1040, seq: 4 }
    ];

    const html = renderRunReport({ run, space, agents, events });
    
    // Cover
    expect(html.coverHtml).not.toContain('Test Space');
    expect(html.coverHtml).toContain('Find the cat');

    // Body
    expect(html.bodyHtml).toContain('<h2>Final Answer</h2>');
    expect(html.bodyHtml).toContain('<strong>Found it</strong>'); // markdown processed
    
    // Cards
    expect(html.bodyHtml).toContain('Chief');
    expect(html.bodyHtml).not.toContain('Boss'); // Role, not name
    expect(html.bodyHtml).toContain('Manager'); // isOrchestrator
    expect(html.bodyHtml).toContain('I am assigning tasks.');
    
    // Tool calls
    expect(html.bodyHtml).toContain('search');
    expect(html.bodyHtml).toContain('{&quot;q&quot;:&quot;cat&quot;}');
    
    // System
    expect(html.bodyHtml).toContain('System intervened');
  });

  it('renders a failed run correctly', () => {
    const run: Run = { id: 'r1', spaceId: 's1', problem: 'Q', status: RunStatus.Failed, roundsUsed: 1, startedAt: 1000, error: 'OOM Error' };
    const html = renderRunReport({ run, space, agents, events: [] });
    
    expect(html.coverHtml).not.toContain('Status: failed');
    expect(html.bodyHtml).toContain('Run failed:');
    expect(html.bodyHtml).toContain('OOM Error');
    expect(html.bodyHtml).not.toContain('<h2>Final Answer</h2>');
  });

  it('renders a stopped run correctly', () => {
    const run: Run = { id: 'r1', spaceId: 's1', problem: 'Q', status: RunStatus.Stopped, roundsUsed: 1, startedAt: 1000 };
    const html = renderRunReport({ run, space, agents, events: [] });
    
    expect(html.coverHtml).not.toContain('Status: stopped');
    expect(html.bodyHtml).toContain('Stopped early');
    expect(html.bodyHtml).not.toContain('<h2>Final Answer</h2>');
  });

  it('renders narrative and key points when provided', () => {
    const run: Run = { id: 'r1', spaceId: 's1', problem: 'Find the cat', status: RunStatus.Completed, roundsUsed: 1, startedAt: 1000, finalAnswer: '**Found it**' };
    const html = renderRunReport({ 
      run, space, agents, events: [],
      narrative: {
        keyPoints: ['Looked hard', 'Found cat'],
        narrativeMarkdown: 'The detective said <quote agent="Detective">I am on it.</quote>'
      }
    });

    // Key points
    expect(html.bodyHtml).toContain('<h3>Key Points</h3>');
    expect(html.bodyHtml).toContain('Looked hard');
    
    // Final Answer
    expect(html.bodyHtml).toContain('<strong>Found it</strong>');
    
    // Narrative replaces cards
    expect(html.bodyHtml).toContain('<div class="narrative-body"');
    expect(html.bodyHtml).toContain('— Detective');
    expect(html.bodyHtml).toContain('<blockquote>'); // from markdown rendering of '> "I am on it."'
    expect(html.bodyHtml).not.toContain('class="card"');
  });
});
