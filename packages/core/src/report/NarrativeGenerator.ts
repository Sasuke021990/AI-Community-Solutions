import { RunReportInput } from './ReportRenderer.js';
import { LmStudioClient } from '../llm/LmStudioClient.js';
import { ChatResponse } from '../llm/types.js';
import { RunEventType } from '../domain/enums.js';
import { Agent, RunEvent } from '../domain/types.js';

export const MAX_TRANSCRIPT_CHARS = 12000;

export interface NarrativeResult {
  keyPoints: string[];
  narrativeMarkdown: string;
}

export function buildPlainTranscript(input: RunReportInput): string {
  let plain = `Problem: ${input.run.problem}\n\n`;
  for (const ev of input.events) {
    if (ev.type === RunEventType.RoundStart) {
      const agent = input.agents.find(a => a.id === ev.agentId);
      const role = agent ? agent.role : 'Unknown Agent';
      plain += `[Turn] ${role}: `;
    } else if (ev.type === RunEventType.AgentMessage) {
      const payload = ev.payload as { message?: { content?: string } };
      plain += `${payload.message?.content || ''}\n`;
    } else if (ev.type === RunEventType.ToolCall) {
      const payload = ev.payload as { toolCall?: { function?: { name: string; arguments: string } } };
      const toolCall = payload.toolCall?.function;
      if (toolCall) {
        plain += `  (used tool "${toolCall.name}" — args: ${toolCall.arguments})\n`;
      }
    } else if (ev.type === RunEventType.System) {
      const payload = ev.payload as { note?: string };
      plain += `[System note] ${payload.note || ''}\n`;
    }
  }
  return plain;
}

export function buildNarrativePrompt(input: RunReportInput, transcript: string) {
  const orchestrator = input.agents.find(a => a.isOrchestrator);
  const orchestratorRole = orchestrator ? orchestrator.role : 'The orchestrator';
  return [
    {
      role: 'system' as const,
      content: `You are a professional report writer. You are summarizing a multi-agent AI discussion about the problem: "${input.run.problem}".\n\n` +
               `The discussion was coordinated by ${orchestratorRole}. \n\n` +
               `Instructions:\n` +
               `1. Write a short bulleted list of the most critical takeaways under [KEY_POINTS].\n` +
               `2. Write a flowing narrative of the discussion under [NARRATIVE].\n` +
               `3. When you quote an agent in the narrative, you MUST use the exact words they said, and wrap the quote in <quote agent="Role">exact text</quote>.\n\n` +
               `Output EXACTLY in this format:\n` +
               `[KEY_POINTS]\n- Point 1\n- Point 2\n[/KEY_POINTS]\n\n[NARRATIVE]\nNarrative prose here, e.g. ${orchestratorRole} noted that <quote agent="${orchestratorRole}">the data shows...</quote>.\n[/NARRATIVE]`
    },
    {
      role: 'user' as const,
      content: `Here is the raw transcript:\n\n${transcript}`
    }
  ];
}

export function parseNarrativeResponse(content: string): NarrativeResult | undefined {
  const kpMatch = content.match(/\[KEY_POINTS\]([\s\S]*?)\[\/KEY_POINTS\]/);
  const narMatch = content.match(/\[NARRATIVE\]([\s\S]*?)\[\/NARRATIVE\]/);
  
  if (!kpMatch || !narMatch) return undefined;
  
  const keyPoints = kpMatch[1]
    .split('\n')
    .map(line => line.replace(/^[\s-*]+/, '').trim())
    .filter(line => line.length > 0);
    
  if (keyPoints.length === 0) return undefined;
  
  const narrativeMarkdown = narMatch[1].trim();
  if (!narrativeMarkdown) return undefined;
  
  return { keyPoints, narrativeMarkdown };
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function allQuotesVerified(narrativeMarkdown: string, agents: Agent[], events: RunEvent[]): boolean {
  const quoteRegex = /<quote agent="([^"]+)">([\s\S]*?)<\/quote>/g;
  let match;
  
  while ((match = quoteRegex.exec(narrativeMarkdown)) !== null) {
    const rawRole = match[1];
    const rawQuote = match[2];
    
    // Minimum quote length check against trivial matches
    if (rawQuote.length < 15) return false;
    
    const roleLower = rawRole.toLowerCase();
    const agent = agents.find(a => a.role.toLowerCase() === roleLower);
    if (!agent) return false; // Agent doesn't exist
    
    // Concatenate all of this agent's messages
    let fullAgentText = '';
    let currentAgentId: string | undefined;
    
    for (const ev of events) {
      if (ev.type === RunEventType.RoundStart) {
        currentAgentId = ev.agentId;
      } else if (ev.type === RunEventType.AgentMessage && currentAgentId === agent.id) {
        const payload = ev.payload as { message?: { content?: string } };
        if (payload.message?.content) {
          fullAgentText += payload.message.content + '\n';
        }
      }
    }
    
    const normalizedQuote = normalizeWhitespace(rawQuote);
    const normalizedSource = normalizeWhitespace(fullAgentText);
    
    if (!normalizedSource.includes(normalizedQuote)) {
      return false; // Not a substring
    }
  }
  
  return true; // Empty narrative with no quotes is technically verified if it passes parse
}

export async function generateNarrative(
  input: RunReportInput,
  lmClient: LmStudioClient,
  model: string
): Promise<NarrativeResult | undefined> {
  const transcript = buildPlainTranscript(input);
  if (transcript.length > MAX_TRANSCRIPT_CHARS) return undefined;
  
  let response: ChatResponse;
  try {
    response = await lmClient.chat(
      { model, messages: buildNarrativePrompt(input, transcript), temperature: 0.3 },
      () => {},
      undefined,
      { overallTimeoutMs: 180_000 }
    );
  } catch {
    return undefined;
  }
  
  const parsed = parseNarrativeResponse(response.message.content);
  if (!parsed) return undefined;
  
  if (!allQuotesVerified(parsed.narrativeMarkdown, input.agents, input.events)) {
    return undefined;
  }
  
  return parsed;
}
