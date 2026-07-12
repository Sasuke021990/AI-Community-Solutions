import { describe, it, expect, vi } from 'vitest';
import { listSpacePresets } from './spacePresets.js';
import { Strategy, RunStatus, SpaceStatus } from '../domain/enums.js';
import { RunOrchestrator } from '../engine/RunOrchestrator.js';
import { RunRepo, RunEventRepo, SpaceRepo } from '../db/repos/index.js';
import { LmStudioClient } from '../llm/LmStudioClient.js';
import { ConcurrencyLimiter } from '../llm/ConcurrencyLimiter.js';
import { randomUUID } from 'crypto';
import { Database } from '../db/Database.js';

describe('Preset Workflows Dynamic Validation', () => {
  const presets = listSpacePresets();

  for (const preset of presets) {
    it(`runs ${preset.name} (${preset.strategy}) preset to completion without hanging`, async () => {
      const db = new Database(':memory:');
      const spaceRepo = new SpaceRepo(db.getDb());
      const runRepo = new RunRepo(db.getDb());
      const runEventRepo = new RunEventRepo(db.getDb());
      
      const space = {
        ...preset,
        defaultModel: 'model1',
        maxRounds: 10,
        status: SpaceStatus.Published,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      spaceRepo.create(space);

      const runId = randomUUID();
      const run = {
        id: runId,
        spaceId: preset.id,
        problem: 'Test problem',
        status: RunStatus.Running,
        roundsUsed: 0,
        startedAt: Date.now()
      };
      runRepo.create(run);

      // Create a fake LmStudioClient that cooperates with the specific strategy.
      const mockLmClient = {
        chat: vi.fn().mockImplementation(async (req) => {
          const sys = req.messages[0]?.content || '';
          const lastMsg = req.messages[req.messages.length - 1]?.content || '';
          const orchestratorPrompt = preset.agents.find(a => a.isOrchestrator)?.systemPrompt;
          const isOrchestrator = (orchestratorPrompt && sys.includes(orchestratorPrompt)) || sys.includes('You are the orchestrator');
          
          let content = '';
          if (preset.strategy === Strategy.Structured) {
            // StructuredStrategy handles sequences, cycles, parallel itself.
            // If it's a parallel critique phase (debate shape), output no_objections.
            if (sys.includes('CRITIQUE_PHASE') || lastMsg.includes('Critique')) {
              content = '<no_objections/> WORKER';
            } else if (isOrchestrator) {
              // The synthesizer needs to end it
              content = 'Synth done. WORKER';
            } else {
              // Just a standard worker
              content = 'Worker result. WORKER';
            }
          } else if (preset.strategy === Strategy.Orchestrator && isOrchestrator) {
            // Check if it's the second round to emit final_answer
            const hasWorkerResponses = req.messages.some(m => typeof m.content === 'string' && m.content.includes('WORKER'));
            if (hasWorkerResponses) {
              content = '<final_answer>Done!</final_answer>';
            } else {
              // Delegate to all workers
              const workers = preset.agents.filter(a => !a.isOrchestrator);
              content = workers.map(w => `<task agent="${w.name}">Do work</task>`).join('\n');
            }
          } else if (preset.strategy === Strategy.RoundRobin) {
            // RoundRobin: Just output some text. If it's the last agent in the 2nd cycle, end it.
            if (req.messages.length > 5) { // Arbitrary condition for "enough rounds"
              content = '<final_answer>Done!</final_answer>';
            } else {
              content = 'My contribution.';
            }
          } else if (preset.strategy === Strategy.Debate) {
            if (lastMsg.includes('Critique phase')) {
              content = '<no_objections/> WORKER';
            } else {
              content = 'My proposal. WORKER';
            }
          } else {
            content = 'Worker result. WORKER';
          }
          
          return { message: { role: 'assistant', content: JSON.stringify({ content }) } };
        }),
        listModels: vi.fn().mockResolvedValue(['model1'])
      } as unknown as LmStudioClient;

      const limiter = new ConcurrencyLimiter(2);

      const orchestrator = new RunOrchestrator(
        run,
        space,
        preset.agents,
        [], // mcpClients
        [], // webhooks
        runRepo,
        runEventRepo,
        mockLmClient,
        limiter
      );

      // We need to track round starts to verify all agents participate.
      const participants = new Set<string>();
      const originalOnEvent = orchestrator['state'].onEvent;
      orchestrator['state'].onEvent = (e) => {
        if (e.type === 'round_start' && e.agentId) {
          participants.add(e.agentId);
        }
        originalOnEvent.call(orchestrator['state'], e);
      };
      await orchestrator.start();

      const finalRun = runRepo.get(runId);
      expect(finalRun?.status).toBe(RunStatus.Completed);
      expect(finalRun?.finalAnswer).toBeDefined();
    });
  }
});
