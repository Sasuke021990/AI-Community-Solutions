// Raw row shapes as stored in SQLite (snake_case columns).
// Repositories cast query results to these instead of `any`.

export interface McpServerRow {
  id: string;
  name: string;
  transport: string;
  command: string | null;
  args: string | null;
  env: string | null;
  url: string | null;
  enabled: number;
  created_at: number;
}

export interface WebhookRow {
  id: string;
  name: string;
  description: string;
  method: string;
  url: string;
  parameterized: number;
  headers: string | null;
  enabled: number;
  created_at: number;
}

export interface SpaceRow {
  id: string;
  name: string;
  description: string;
  strategy: string;
  default_model: string;
  max_rounds: number;
  status: string;
  preset_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface AgentRow {
  id: string;
  space_id: string;
  name: string;
  role: string;
  system_prompt: string;
  model_id: string | null;
  is_orchestrator: number;
  position: number;
}

export interface RunRow {
  id: string;
  space_id: string;
  problem: string;
  status: string;
  rounds_used: number;
  final_answer: string | null;
  pdf_path: string | null;
  error: string | null;
  started_at: number;
  finished_at: number | null;
}

export interface RunEventRow {
  id: string;
  run_id: string;
  seq: number;
  type: string;
  agent_id: string | null;
  payload: string;
  at: number;
}
