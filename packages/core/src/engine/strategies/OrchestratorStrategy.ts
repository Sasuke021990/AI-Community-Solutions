import { AgentStrategy, ExecutionState } from './AgentStrategy.js';
import { buildAgentMessages, callAgent, extractFinalAnswer } from './AgentCaller.js';

interface TaskAssignment {
  agentName: string;
  task: string;
}

/** Parses <task agent="Name">description</task> blocks from orchestrator output. */
export function parseTaskAssignments(content: string): TaskAssignment[] {
  const re = /<task\s+agent="([^"]+)"\s*>([\s\S]*?)<\/task>/gi;
  const out: TaskAssignment[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push({ agentName: m[1].trim(), task: m[2].trim() });
  }
  return out;
}

export class OrchestratorStrategy implements AgentStrategy {
  public async executeRound(state: ExecutionState): Promise<{ finalAnswer?: string }> {
    const orchestrator = state.agents.find((a) => a.isOrchestrator);
    if (!orchestrator) throw new Error('Orchestrator not found');
    const workers = state.agents.filter((a) => !a.isOrchestrator);

    const plannerGuidance =
      workers.length > 0
        ? `You are the orchestrator. You may delegate subtasks to these workers: ${workers
            .map((w) => w.name)
            .join(', ')}. To delegate, output one or more <task agent="WorkerName">task description</task> blocks. ` +
          `Review their results in later turns. When the problem is fully solved, output <final_answer>...</final_answer>.`
        : 'You are the orchestrator. Solve the problem directly. When done, output <final_answer>...</final_answer>.';

    const planMessages = buildAgentMessages(orchestrator, state.run.problem, state.messages, plannerGuidance);
    const planMsg = await callAgent(state, orchestrator, planMessages);
    state.messages.push({ role: 'assistant', content: `ORCHESTRATOR: ${planMsg.content}` });

    const finalAnswer = extractFinalAnswer(planMsg.content);
    if (finalAnswer) return { finalAnswer };

    const tasks = parseTaskAssignments(planMsg.content);
    if (tasks.length === 0) {
      // No delegation this turn; orchestrator continues next round.
      return {};
    }

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
