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
  /** True once at least one <task> has resolved to a real worker and run. */
  private hasDelegated = false;

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
            `- You MUST delegate to at least one worker before providing a final answer — this is a ` +
              `multi-perspective session, so answering the problem yourself instead of delegating is not allowed.`,
            `- When the problem is fully solved, output <final_answer>...</final_answer> and nothing else.`
          ].join('\n')
        : 'You are the orchestrator. Solve the problem directly. When done, output <final_answer>...</final_answer>.';

    const planMessages = buildAgentMessages(orchestrator, state.run.problem, state.messages, plannerGuidance);
    const planMsg = await callAgent(state, orchestrator, planMessages);
    state.messages.push({ role: 'assistant', content: `ORCHESTRATOR: ${planMsg.content}` });

    const finalAnswer = extractFinalAnswer(planMsg.content);
    // A final answer offered before ever delegating to a worker defeats the
    // point of a multi-agent Space - reject it and force at least one real
    // delegation round, rather than letting the orchestrator just answer
    // the problem itself using its own reasoning/tools.
    const prematureFinalAnswer = !!finalAnswer && workers.length > 0 && !this.hasDelegated;
    if (finalAnswer && !prematureFinalAnswer) return { finalAnswer };

    const tasks = parseTaskAssignments(planMsg.content);
    const isDuplicate = planMsg.content.trim() === this.lastOrchestratorOutput.trim();
    this.lastOrchestratorOutput = planMsg.content;

    if (tasks.length === 0 || isDuplicate || prematureFinalAnswer) {
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
        content: prematureFinalAnswer
          ? 'SYSTEM: You provided a final answer without ever delegating to a worker. You MUST delegate to at ' +
            'least one worker first, using the exact format <task agent="WorkerName">task</task>. Do that now — ' +
            'do not answer the problem yourself.'
          : 'SYSTEM: You neither delegated a subtask nor gave a final answer. You MUST either delegate using ' +
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
          return { name: agentName, content: `(no worker named "${agentName}" exists)`, real: false };
        }
        const messages = buildAgentMessages(worker, state.run.problem, state.messages, `Your assigned subtask: ${task}`);
        const msg = await callAgent(state, worker, messages);
        return { name: worker.name, content: msg.content, real: true };
      })
    );

    if (results.some((r) => r.real)) this.hasDelegated = true;

    for (const r of results) {
      state.messages.push({ role: 'assistant', content: `WORKER ${r.name}: ${r.content}` });
    }

    return {};
  }
}
