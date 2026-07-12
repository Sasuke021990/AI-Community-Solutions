export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface ResponseFormat {
  type: 'json_schema';
  json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: unknown[]; // OpenAI function schema
  temperature?: number;
  frequency_penalty?: number;
  response_format?: ResponseFormat;
}

export interface ChatResponse {
  message: ChatMessage;
}
