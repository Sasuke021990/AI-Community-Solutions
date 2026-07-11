import { Space, Agent } from './types.js';
import { Strategy } from './enums.js';

export interface ValidationIssue {
  field?: string;
  message: string;
}

export function validateSpaceForPublish(space: Space, agents: Agent[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  
  if (agents.length === 0) {
    issues.push({ message: 'A Space must have at least one agent to be published.' });
  }

  const orchestrators = agents.filter(a => a.isOrchestrator);
  
  if (space.strategy === Strategy.Orchestrator) {
    if (orchestrators.length !== 1) {
      issues.push({ 
        field: 'strategy',
        message: 'Orchestrator strategy requires exactly one agent designated as the orchestrator.' 
      });
    }
  } else {
    if (orchestrators.length > 0) {
      issues.push({
        field: 'strategy',
        message: 'Only the orchestrator strategy can have an agent designated as the orchestrator.'
      });
    }
  }

  return issues;
}
