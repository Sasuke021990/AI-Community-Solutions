import { AgentStrategy, ExecutionState } from './AgentStrategy.js';
import { buildAgentMessages, callAgent, extractFinalAnswer } from './AgentCaller.js';
import { RunEventType } from '../../domain/enums.js';

interface TaskAssignment {
  agentName: string;
  task: string;
}

/** Parses <task agent="Name">description</task> blocks from orchestrator output. */
export function parseTaskAssignments(content: string): TaskAssignment[] {
  const re = /<task\s+agent\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/task>/gi;
  const out: TaskAssignment[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push({ agentName: m[1].trim(), task: m[2].trim() });
  }
  return out;
}

export class OrchestratorStrategy implements AgentStrategy {
  private noProgressStreak = 0;
  private lastOrchestratorOutput = '';

  public async executeRound(state: ExecutionState): Promise<{ finalAnswer?: string; halt?: boolean }> {
    const orchestrator = state.agents.find((a) => a.isOrchestrator);
    if (!orchestrator) throw new Error('Orchestrator not found');
    const workers = state.agents.filter((a) => !a.isOrchestrator);

    const plannerGuidance =
      workers.length > 0
        ? [
            `You are the orchestrator. Available workers: ${workers.map((w) => w.name).join(', ')}.`,
            `To delegate, output one or more task blocks in EXACTLY this format, each on its own line:`,
            `<task agent="WorkerName">the specific subtask for that worker</task>`,
            `Example:`,
            `<task agent="${workers[0].name}">Gather the key facts and figures relevant to the problem.</task>`,
            `Rules:`,
            `- Prose like "WorkerName: do X" does NOT delegate — ONLY <task agent="..."> blocks trigger a worker.`,
            `- Delegate real work every turn until the problem is solved; do not just narrate.`,
            `- When the problem is fully solved, output <final_answer>...</final_answer> and nothing else.`
          ].join('\n')
        : 'You are the orchestrator. Solve the problem directly. When done, output <final_answer>...</final_answer>.';

    const planMessages = buildAgentMessages(orchestrator, state.run.problem, state.messages, plannerGuidance);
    const planMsg = await callAgent(state, orchestrator, planMessages);
    state.messages.push({ role: 'assistant', content: `ORCHESTRATOR: ${planMsg.content}` });

    const finalAnswer = extractFinalAnswer(planMsg.content);
    if (finalAnswer) return { finalAnswer };

    const tasks = parseTaskAssignments(planMsg.content);
    const isDuplicate = planMsg.content.trim() === this.lastOrchestratorOutput.trim();
    this.lastOrchestratorOutput = planMsg.content;

    if (tasks.length === 0 || isDuplicate) {
      this.noProgressStreak++;
      if (this.noProgressStreak >= 2) {
        state.onEvent({
          type: RunEventType.System,
          payload: { note: 'Orchestrator made no progress across rounds; synthesizing a best-effort answer.' }
        });
        return { halt: true };
      }
      // First offense: correct the orchestrator and give it another round.
      state.messages.push({
        role: 'user',
        content:
          'SYSTEM: You neither delegated a subtask nor gave a final answer. You MUST either delegate using ' +
          'the exact format <task agent="WorkerName">task</task>, or output <final_answer>...</final_answer>. Do one now.'
      });
      return {};
    }

    this.noProgressStreak = 0;

    // Dispatch independent subtasks to workers concurrently.
    const results = await Promise.all(
      tasks.map(async ({ agentName, task }) => {
        const worker = workers.find((w) => w.name.toLowerCase() === agentName.toLowerCase());
        if (!worker) {
          return { name: agentName, content: `(no worker named "${agentName}" exists)` };
        }
        const messages = buildAgentMessages(worker, state.run.problem, state.messages, `Your assigned subtask: ${task}`);
        const msg = await callAgent(state, worker, messages);
        return { name: worker.name, content: msg.content };
      })
    );

    for (const r of results) {
      state.messages.push({ role: 'assistant', content: `WORKER ${r.name}: ${r.content}` });
    }

    return {};
  }
}
