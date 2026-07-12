import { describe, it, expect, vi } from 'vitest';
import { 
  buildPlainTranscript, 
  parseNarrativeResponse, 
  allQuotesVerified, 
  generateNarrative, 
  MAX_TRANSCRIPT_CHARS 
} from './NarrativeGenerator.js';
import { RunReportInput } from './ReportRenderer.js';
import { RunEventType, RunStatus, Strategy, SpaceStatus } from '../domain/enums.js';
import { LmStudioClient } from '../llm/LmStudioClient.js';

describe('NarrativeGenerator', () => {
  const mockInput: RunReportInput = {
    run: { id: 'r1', spaceId: 's1', problem: 'Solve X', roundsUsed: 1, startedAt: 1, status: RunStatus.Completed },
    space: { id: 's1', name: 'S1', description: '', defaultModel: 'm1', maxRounds: 5, strategy: Strategy.RoundRobin, status: SpaceStatus.Published, createdAt: 1, updatedAt: 1 },
    agents: [
      { id: 'a1', spaceId: 's1', name: 'A1', role: 'White Hat', position: 1, isOrchestrator: false, systemPrompt: '' },
      { id: 'a2', spaceId: 's1', name: 'A2', role: 'Blue Hat', position: 2, isOrchestrator: true, systemPrompt: '' },
    ],
    events: [
      { id: 'e1', runId: 'r1', seq: 1, type: RunEventType.RoundStart, agentId: 'a1', payload: {}, at: 1 },
      { id: 'e2', runId: 'r1', seq: 2, type: RunEventType.AgentMessage, agentId: 'a1', payload: { message: { content: 'The data is clear.' } }, at: 2 },
      { id: 'e3', runId: 'r1', seq: 3, type: RunEventType.RoundStart, agentId: 'a2', payload: {}, at: 3 },
      { id: 'e4', runId: 'r1', seq: 4, type: RunEventType.AgentMessage, agentId: 'a2', payload: { message: { content: 'I agree entirely.' } }, at: 4 },
    ]
  };

  it('builds a plain transcript correctly', () => {
    const plain = buildPlainTranscript(mockInput);
    expect(plain).toContain('Problem: Solve X');
    expect(plain).toContain('[Turn] White Hat: The data is clear.');
    expect(plain).toContain('[Turn] Blue Hat: I agree entirely.');
  });

  it('parses well-formed narrative response', () => {
    const content = `[KEY_POINTS]\n- Point 1\n- Point 2\n[/KEY_POINTS]\n\n[NARRATIVE]\nHello world <quote agent="White Hat">The data is clear.</quote>\n[/NARRATIVE]`;
    const parsed = parseNarrativeResponse(content);
    expect(parsed?.keyPoints).toEqual(['Point 1', 'Point 2']);
    expect(parsed?.narrativeMarkdown).toContain('Hello world');
  });

  it('returns undefined if KEY_POINTS or NARRATIVE missing', () => {
    expect(parseNarrativeResponse(`[NARRATIVE]Hello[/NARRATIVE]`)).toBeUndefined();
    expect(parseNarrativeResponse(`[KEY_POINTS]- P1[/KEY_POINTS]`)).toBeUndefined();
  });

  it('verifies quotes correctly against events', () => {
    const validNarrative = `He said <quote agent="White Hat">The data is clear.</quote>`;
    expect(allQuotesVerified(validNarrative, mockInput.agents, mockInput.events)).toBe(true);
    
    // Fails on altered words
    const invalidNarrative = `He said <quote agent="White Hat">The data is very clear.</quote>`;
    expect(allQuotesVerified(invalidNarrative, mockInput.agents, mockInput.events)).toBe(false);

    // Fails on wrong agent
    const wrongAgent = `He said <quote agent="Blue Hat">The data is clear.</quote>`;
    expect(allQuotesVerified(wrongAgent, mockInput.agents, mockInput.events)).toBe(false);
  });

  it('verifies quotes with normalized whitespace', () => {
    const validNarrative = `He said <quote agent="White Hat">The    data \n is   clear.</quote>`;
    expect(allQuotesVerified(validNarrative, mockInput.agents, mockInput.events)).toBe(true);
  });

  it('rejects short trivial quotes', () => {
    const trivialQuote = `He said <quote agent="White Hat">The</quote>`; // < 15 chars
    expect(allQuotesVerified(trivialQuote, mockInput.agents, mockInput.events)).toBe(false);
  });

  it('returns undefined if chat throws', async () => {
    const client = new LmStudioClient();
    vi.spyOn(client, 'chat').mockRejectedValue(new Error('Timeout'));
    const result = await generateNarrative(mockInput, client, 'm1');
    expect(result).toBeUndefined();
  });

  it('returns undefined if transcript exceeds MAX_TRANSCRIPT_CHARS without calling chat', async () => {
    const client = new LmStudioClient();
    const spy = vi.spyOn(client, 'chat');
    
    const longInput = { ...mockInput, run: { ...mockInput.run, problem: 'X'.repeat(MAX_TRANSCRIPT_CHARS + 1) } };
    const result = await generateNarrative(longInput, client, 'm1');
    
    expect(result).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns NarrativeResult when generation succeeds and validates', async () => {
    const client = new LmStudioClient();
    vi.spyOn(client, 'chat').mockResolvedValue({
      message: { 
        role: 'assistant', 
        content: `[KEY_POINTS]\n- KP1\n[/KEY_POINTS]\n[NARRATIVE]\nTest <quote agent="White Hat">The data is clear.</quote>\n[/NARRATIVE]`
      },
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    });
    
    const result = await generateNarrative(mockInput, client, 'm1');
    expect(result).toBeDefined();
    expect(result?.keyPoints).toEqual(['KP1']);
    expect(result?.narrativeMarkdown).toContain('Test');
  });

  it('returns undefined when generation succeeds but quote fails validation', async () => {
    const client = new LmStudioClient();
    vi.spyOn(client, 'chat').mockResolvedValue({
      message: { 
        role: 'assistant', 
        content: `[KEY_POINTS]\n- KP1\n[/KEY_POINTS]\n[NARRATIVE]\nTest <quote agent="White Hat">Fake quote here of sufficient length.</quote>\n[/NARRATIVE]`
      },
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    });
    
    const result = await generateNarrative(mockInput, client, 'm1');
    expect(result).toBeUndefined();
  });
});
