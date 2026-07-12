export enum Strategy {
  Orchestrator = 'orchestrator',
  RoundRobin = 'round-robin',
  Debate = 'debate',
  Structured = 'structured'
}

export enum SpaceStatus {
  Draft = 'draft',
  Published = 'published'
}

export enum RunStatus {
  Running = 'running',
  Completed = 'completed',
  Failed = 'failed',
  Stopped = 'stopped'
}

export enum RunEventType {
  AgentMessage = 'agent_message',
  ToolCall = 'tool_call',
  ToolResult = 'tool_result',
  RoundStart = 'round_start',
  System = 'system'
}
