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
  /** Ids of workers that have actually run at least once. */
  private delegatedWorkerIds = new Set<string>();

  public async executeRound(state: ExecutionState): Promise<{ finalAnswer?: string; halt?: boolean }> {
    const orchestrator = state.agents.find((a) => a.isOrchestrator);
    if (!orchestrator) throw new Error('Orchestrator not found');
    const workers = state.agents.filter((a) => !a.isOrchestrator);
    const remainingWorkers = workers.filter((w) => !this.delegatedWorkerIds.has(w.id));

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
            `- Every worker must be consulted at least once before you may give a final answer — this is a ` +
              `multi-perspective session; skipping a worker, or answering the problem yourself, is not allowed.`,
            `- Prefer delegating to SEVERAL workers at once (multiple <task> blocks in one response) rather ` +
              `than one worker per turn, so you don't run out of rounds before everyone has contributed.`,
            remainingWorkers.length > 0 && remainingWorkers.length < workers.length
              ? `- Not yet consulted: ${remainingWorkers.map((w) => w.name).join(', ')}. Delegate to all of them now.`
              : '',
            `- When the problem is fully solved, output <final_answer>...</final_answer> and nothing else.`
          ]
            .filter(Boolean)
            .join('\n')
        : 'You are the orchestrator. Solve the problem directly. When done, output <final_answer>...</final_answer>.';

    const planMessages = buildAgentMessages(orchestrator, state.run.problem, state.messages, plannerGuidance);
    const planMsg = await callAgent(state, orchestrator, planMessages);
    state.messages.push({ role: 'assistant', content: `ORCHESTRATOR: ${planMsg.content}` });

    const finalAnswer = extractFinalAnswer(planMsg.content);
    // A final answer offered before every worker has been consulted defeats
    // the point of a multi-agent Space - reject it and force delegation to
    // whoever's left, rather than letting the orchestrator wrap up early
    // (or skip straight to answering the problem itself).
    const prematureFinalAnswer = !!finalAnswer && remainingWorkers.length > 0;
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
          ? `SYSTEM: You gave a final answer, but ${remainingWorkers.map((w) => w.name).join(', ')} ` +
            `${remainingWorkers.length === 1 ? 'has' : 'have'} not been consulted yet. Delegate to ` +
            `${remainingWorkers.length === 1 ? 'them' : 'all of them'} now, using ` +
            '<task agent="WorkerName">task</task> — do not answer until everyone has contributed.'
          : 'SYSTEM: You neither delegated a subtask nor gave a final answer. You MUST either delegate using ' +
            'the exact format <task agent="WorkerName">task</task>, or output <final_answer>...</final_answer>. Do one now.'
      });
      return {};
    }

    // Dispatch independent subtasks to workers concurrently.
    const results = await Promise.all(
      tasks.map(async ({ agentName, task }) => {
        const worker = workers.find((w) => w.name.toLowerCase() === agentName.toLowerCase());
        if (!worker) {
          return { name: agentName, content: `(no worker named "${agentName}" exists)`, workerId: undefined };
        }
        const messages = buildAgentMessages(worker, state.run.problem, state.messages, `Your assigned subtask: ${task}`);
        const msg = await callAgent(state, worker, messages);
        return { name: worker.name, content: msg.content, workerId: worker.id };
      })
    );

    for (const r of results) {
      if (r.workerId) this.delegatedWorkerIds.add(r.workerId);
      state.messages.push({ role: 'assistant', content: `WORKER ${r.name}: ${r.content}` });
    }

    // A round where the orchestrator delegated but EVERY dispatched worker
    // returned empty content is not real progress - it's a sign the model is
    // failing (returning empty completions). Count it toward the no-progress
    // streak instead of resetting, so a broken model halts in a couple of
    // rounds rather than looping to maxRounds producing nothing.
    const anyRealContent = results.some((r) => r.workerId && r.content.trim().length > 0);
    if (anyRealContent) {
      this.noProgressStreak = 0;
    } else {
      this.noProgressStreak++;
      if (this.noProgressStreak >= 2) {
        state.onEvent({
          type: RunEventType.System,
          payload: {
            note: 'Delegated workers returned no content across rounds (the model may be failing or overloaded); synthesizing a best-effort answer.'
          }
        });
        return { halt: true };
      }
    }

    return {};
  }
}
