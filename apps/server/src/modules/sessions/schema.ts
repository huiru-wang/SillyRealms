import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { JsonObject } from '../../infrastructure/database/connection.js';

export const identifier = z.string().min(1).refine(value => value === value.trim(), 'Identifiers cannot have surrounding whitespace');
const jsonObject = z.custom<JsonObject>(value => value !== null && typeof value === 'object' && !Array.isArray(value));

const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const duration = z.number().nonnegative().finite();

const messageFields = { content: z.string(), timestamp: z.number().int().nonnegative() };
const messagePayloadSchema = z.object({
  message: z.discriminatedUnion('role', [
    z.object({ ...messageFields, role: z.literal('user') }).strict(),
    z.object({
      ...messageFields, role: z.literal('assistant'), reasoning_content: z.string().optional(),
      tool_calls: z.array(z.object({
        index: z.number().int().nonnegative(), id: z.string(), type: z.literal('function'),
        function: z.object({ name: z.string(), arguments: z.string() }).strict(),
      }).strict()).optional(),
    }).strict(),
  ]),
}).strict();

export function validateMessagePayload(payload: unknown, role: 'user' | 'assistant') {
  const { message } = messagePayloadSchema.parse(payload);
  if (message.role !== role) throw new AppError('INVALID_REQUEST', '消息角色与条目不一致');
  return message;
}

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
    provider: identifier,
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

export const runtimeConfigSchema = z.object({
  narrativePresetId: identifier,
  apiModelConfigId: identifier,
  replyAssistPresetId: identifier.nullable(),
  replyAssistGoal: z.string().max(2000),
  fontSize: z.number().int().min(13).max(21),
}).strict();
const initialRuntimeConfig = runtimeConfigSchema.extend({
  replyAssistPresetId: runtimeConfigSchema.shape.replyAssistPresetId.default(null),
  replyAssistGoal: runtimeConfigSchema.shape.replyAssistGoal.default(''),
  fontSize: runtimeConfigSchema.shape.fontSize.default(16),
});
export const createSessionSchema = z.object({
  id: identifier.optional(), worldId: identifier, runtimeConfig: initialRuntimeConfig,
  userCharacterId: identifier,
  title: z.string().nullable().optional(), state: jsonObject.optional(),
}).strict();
export const updateSessionSchema = z.object({
  runtimeConfig: runtimeConfigSchema.partial().optional(),
  title: z.string().nullable().optional(),
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
