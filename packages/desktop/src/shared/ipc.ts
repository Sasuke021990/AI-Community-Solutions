import { z } from 'zod';
import { Strategy } from '@acs/core';

/**
 * Schema-first IPC contract (Decision #21). Every channel's REQUEST payload
 * (renderer -> main, untrusted) is validated at runtime against a Zod schema
 * defined here; TypeScript types are inferred from the same schema so they
 * cannot drift from the validator.
 *
 * RESPONSE payloads are not given their own Zod schemas: they are produced by
 * our own trusted @acs/core code, so re-validating them at the boundary would
 * duplicate the domain types already defined in core (and risk drifting from
 * them) for no safety benefit. Response types below simply reuse @acs/core's
 * existing TS types. Push-channel payloads (main -> renderer) are likewise
 * unvalidated, per Decision #21.
 */

export const RUN_EVENT_PUSH_CHANNEL = 'runs:event';
export const RUN_STATUS_PUSH_CHANNEL = 'runs:status';
/** Token-level streaming channel — never persisted, high-frequency, ephemeral. */
export const RUN_TOKEN_PUSH_CHANNEL = 'runs:token';


export interface IpcError {
  code: string;
  message: string;
  details?: unknown;
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError };

export interface ChannelDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  requestSchema: S;
}

// Note: S (not a separately-named Req type param) is preserved verbatim, so
// `.parse()` on requestSchema keeps the schema's real *output* type (e.g.
// `.default()` fields become non-optional after parsing). Collapsing this to
// `z.ZodType<Req>` made TS infer Req from the *input* type instead (where
// defaulted fields are still optional), since ZodType's Output and Input
// generic parameters can't both be pinned to one Req when they differ.
export function defineChannel<S extends z.ZodTypeAny>(name: string, requestSchema: S): ChannelDef<S> {
  return { name, requestSchema };
}

// ---- Reusable request fragments -------------------------------------------------

export const EmptySchema = z.object({}).strict();
export const IdSchema = z.object({ id: z.string().min(1) });
export const PathSchema = z.object({ path: z.string().min(1) });


// ---- MCP servers ------------------------------------------------------------------

const McpServerBaseSchema = z.object({
  name: z.string().min(1),
  transport: z.enum(['stdio', 'http']),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  url: z.string().url().optional(),
  enabled: z.boolean().default(true)
});

function requireTransportFields<T extends z.infer<typeof McpServerBaseSchema>>(v: T, ctx: z.RefinementCtx) {
  if (v.transport === 'stdio' && !v.command) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Stdio transport requires a command', path: ['command'] });
  }
  if (v.transport === 'http' && !v.url) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'HTTP transport requires a url', path: ['url'] });
  }
}

export const McpServerInputSchema = McpServerBaseSchema.superRefine(requireTransportFields);
export const McpServerUpdateSchema = McpServerBaseSchema.extend({ id: z.string().min(1) }).superRefine(requireTransportFields);

// ---- Webhooks -----------------------------------------------------------------------

const WebhookBaseSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  method: z.enum(['GET', 'POST']),
  url: z.string().url(),
  parameterized: z.boolean().default(false),
  headers: z.record(z.string()).optional(),
  enabled: z.boolean().default(true)
});
export const WebhookInputSchema = WebhookBaseSchema;
export const WebhookUpdateSchema = WebhookBaseSchema.extend({ id: z.string().min(1) });

// ---- Spaces -------------------------------------------------------------------------

export const SpaceInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  strategy: z.nativeEnum(Strategy),
  defaultModel: z.string().min(1),
  maxRounds: z.number().int().min(1).max(50),
  temperature: z.number().min(0).max(2).optional(),
  allowedMcpServerIds: z.array(z.string()).optional(),
  allowedWebhookIds: z.array(z.string()).optional()
});
export const SpaceUpdateSchema = SpaceInputSchema.extend({ id: z.string().min(1) });
export const SpaceUpdateTemperatureSchema = z.object({ id: z.string().min(1), temperature: z.number().min(0).max(2).optional() });

// ---- Agents ---------------------------------------------------------------------------

export const AgentInputSchema = z.object({
  spaceId: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  systemPrompt: z.string().min(1),
  modelId: z.string().optional(),
  isOrchestrator: z.boolean().default(false),
  position: z.number().int().min(0)
});
export const AgentUpdateSchema = AgentInputSchema.extend({ id: z.string().min(1) });
export const AgentDeleteSchema = z.object({ id: z.string().min(1), spaceId: z.string().min(1) });
export const AgentsListBySpaceSchema = z.object({ spaceId: z.string().min(1) });

// ---- Runs -----------------------------------------------------------------------------

export const RunsStartSchema = z.object({ spaceId: z.string().min(1), problem: z.string().min(1) });
export const RunsStopSchema = z.object({ runId: z.string().min(1) });
export const RunsListBySpaceSchema = z.object({ spaceId: z.string().min(1) });
export const RunsEventsSchema = z.object({ runId: z.string().min(1) });

// ---- Settings ---------------------------------------------------------------------------

export const SettingsPatchSchema = z.object({
  lmStudioBaseUrl: z.string().url().optional(),
  concurrencyCap: z.number().int().min(1).max(8).optional(),
  reportsFolder: z.string().min(1).optional(),
  firstTokenTimeoutSec: z.number().int().min(10).max(900).optional(),
  interTokenTimeoutSec: z.number().int().min(10).max(900).optional()
});

// ---- Presets ----------------------------------------------------------------------------

export const SpaceCreateFromPresetSchema = z.object({ presetId: z.string().min(1) });

// ---- Channel registry -------------------------------------------------------------------

export const Channels = {
  mcpList: defineChannel('mcp:list', EmptySchema),
  mcpCreate: defineChannel('mcp:create', McpServerInputSchema),
  mcpUpdate: defineChannel('mcp:update', McpServerUpdateSchema),
  mcpDelete: defineChannel('mcp:delete', IdSchema),
  mcpTest: defineChannel('mcp:test', McpServerInputSchema),

  webhooksList: defineChannel('webhooks:list', EmptySchema),
  webhooksCreate: defineChannel('webhooks:create', WebhookInputSchema),
  webhooksUpdate: defineChannel('webhooks:update', WebhookUpdateSchema),
  webhooksDelete: defineChannel('webhooks:delete', IdSchema),
  webhooksTest: defineChannel('webhooks:test', WebhookInputSchema),

  spacesList: defineChannel('spaces:list', EmptySchema),
  spacesGet: defineChannel('spaces:get', IdSchema),
  spacesCreate: defineChannel('spaces:create', SpaceInputSchema),
  spacesUpdate: defineChannel('spaces:update', SpaceUpdateSchema),
  spacesUpdateTemperature: defineChannel('spaces:updateTemperature', SpaceUpdateTemperatureSchema),
  spacesDelete: defineChannel('spaces:delete', IdSchema),
  spacesPublish: defineChannel('spaces:publish', IdSchema),
  spacesUnpublish: defineChannel('spaces:unpublish', IdSchema),

  agentsListBySpace: defineChannel('agents:listBySpace', AgentsListBySpaceSchema),
  agentsCreate: defineChannel('agents:create', AgentInputSchema),
  agentsUpdate: defineChannel('agents:update', AgentUpdateSchema),
  agentsDelete: defineChannel('agents:delete', AgentDeleteSchema),

  runsStart: defineChannel('runs:start', RunsStartSchema),
  runsStop: defineChannel('runs:stop', RunsStopSchema),
  runsGet: defineChannel('runs:get', IdSchema),
  runsListBySpace: defineChannel('runs:listBySpace', RunsListBySpaceSchema),
  runsEvents: defineChannel('runs:events', RunsEventsSchema),
  runsOpenPdf: defineChannel('runs:openPdf', PathSchema),
  runsShowInFolder: defineChannel('runs:showInFolder', PathSchema),

  modelsList: defineChannel('models:list', EmptySchema),

  settingsGet: defineChannel('settings:get', EmptySchema),
  settingsSet: defineChannel('settings:set', SettingsPatchSchema),

  templatesList: defineChannel('templates:list', EmptySchema),

  presetsList: defineChannel('presets:list', EmptySchema),
  spacesCreateFromPreset: defineChannel('spaces:createFromPreset', SpaceCreateFromPresetSchema)
} as const;

export type ChannelName = (typeof Channels)[keyof typeof Channels]['name'];
