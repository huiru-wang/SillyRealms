import { z } from 'zod';
import type { JsonObject, JsonValue } from '../../infrastructure/database/connection.js';

export const identifier = z.string().min(1).refine(value => value === value.trim(), 'Identifiers cannot have surrounding whitespace');
const jsonObject = z.custom<JsonObject>(value => value !== null && typeof value === 'object' && !Array.isArray(value));
const jsonArray = z.custom<JsonValue[]>(Array.isArray);
const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const duration = z.number().nonnegative().finite();

const usageSchema = z.object({
  // inputTokens already includes cached input. Cache counters are a breakdown, not extra input.
  inputTokens: tokenCount, outputTokens: tokenCount, totalTokens: tokenCount,
  cacheReadTokens: tokenCount, cacheWriteTokens: tokenCount,
}).strict().refine(value => value.cacheReadTokens + value.cacheWriteTokens <= value.inputTokens, {
  message: 'Cache tokens must be included in inputTokens',
});

export const metricsSchema = z.object({
  requests: z.array(z.object({
    requestId: identifier,
    modelId: identifier,
    provider: identifier.nullable(),
    usage: usageSchema.nullable(),
    durationMs: duration.optional(),
    firstTextMs: duration.optional(),
  }).strict()),
  // Main-request compilation metadata only; missing historical snapshots stay unknown.
  context: z.object({
    requestId: identifier,
    apiModelConfigId: identifier,
    contextWindowTokens: tokenCount.positive(),
    contextComposition: z.object({
      systemBytes: tokenCount, summaryBytes: tokenCount, historyBytes: tokenCount,
    }).strict(),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  value.requests.forEach((request, index) => {
    if (seen.has(request.requestId)) ctx.addIssue({
      code: 'custom', path: ['requests', index, 'requestId'], message: 'Duplicate requestId',
    });
    seen.add(request.requestId);
    if (request.durationMs !== undefined && request.firstTextMs !== undefined && request.firstTextMs > request.durationMs) {
      ctx.addIssue({ code: 'custom', path: ['requests', index, 'firstTextMs'], message: 'First text cannot arrive after request completion' });
    }
  });
  if (value.context && !seen.has(value.context.requestId)) {
    ctx.addIssue({ code: 'custom', path: ['context', 'requestId'], message: 'Context must reference a recorded request' });
  }
});

export const createSessionSchema = z.object({
  id: identifier.optional(), worldId: identifier, presetId: identifier,
  apiModelConfigId: identifier, userCharacterId: identifier,
  title: z.string().nullable().optional(), state: jsonObject.optional(),
}).strict();
export const updateSessionSchema = z.object({
  presetId: identifier.optional(), apiModelConfigId: identifier.optional(),
  title: z.string().nullable().optional(),
}).strict();
const internalExtData = jsonObject
  .refine(value => !Object.hasOwn(value, 'narrative'), 'narrative 由服务端维护')
  .refine(value => !Object.hasOwn(value, 'output'), 'output 由服务端维护');
const editableExtData = internalExtData.refine(value => !Object.hasOwn(value, 'summary'), 'summary 由服务端维护');
const appendFields = {
  id: identifier.optional(), parentId: identifier.nullable().optional(), runId: identifier,
  timestamp: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  payload: jsonObject, state: jsonArray.nullable().optional(),
  extData: editableExtData.optional(), metrics: metricsSchema.nullable().optional(),
};
export const appendEntrySchema = z.discriminatedUnion('type', [
  z.object({ ...appendFields, type: z.literal('message'), role: z.enum(['user', 'assistant']) }).strict(),
  z.object({ ...appendFields, type: z.literal('compaction'), role: z.null(), extData: internalExtData.optional() }).strict(),
]);
export const updateEntrySchema = z.object({
  payload: jsonObject.optional(), extData: editableExtData.optional(),
}).strict();
export const sessionListSchema = z.object({
  worldId: identifier.optional(),
  limit: z.number().int().min(1).max(1000).default(100),
  before: z.object({
    updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    id: identifier,
  }).strict().optional(),
}).strict();
export const narrativeStopReasonSchema = z.enum([
  'cancelled', 'server_shutdown', 'provider_aborted', 'provider_error',
  'provider_context_window_exceeded', 'model_not_found', 'model_capability_unsupported',
  'credential_not_configured', 'credential_unavailable', 'context_budget_exceeded',
  'invalid_context', 'output_limit_reached', 'output_incomplete', 'model_output_invalid', 'tool_execution_unsupported',
  'summary_capacity_exceeded', 'summary_failed',
  'message_persist_failed', 'tip_conflict', 'session_deleted', 'internal_error',
]);
export const narrativeOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('completed'), assistantEntryId: identifier.optional(), finishedAt: z.number().int().nonnegative() }).strict(),
  z.object({ status: z.literal('stopped'), assistantEntryId: identifier.optional(), stopReason: narrativeStopReasonSchema,
    finishedAt: z.number().int().nonnegative() }).strict(),
]);
export const entryRunListSchema = z.object({
  limit: z.number().int().min(1).max(5).optional(),
  beforeSeq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  afterSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict().refine(value => value.beforeSeq === undefined || value.afterSeq === undefined,
  'beforeSeq 与 afterSeq 不能同时提供');

/** Legacy metrics are normalized on read; all new writes use the strict current schema. */
export function readStoredMetrics(value: unknown) {
  if (value && typeof value === 'object' && 'requests' in value && Array.isArray(value.requests)) {
    return metricsSchema.parse({ ...value, requests: value.requests.map((request: Record<string, unknown>) => {
      const result = { ...request, provider: request.provider ?? null };
      Reflect.deleteProperty(result, 'status');
      return result;
    }) });
  }
  return metricsSchema.parse(value);
}
