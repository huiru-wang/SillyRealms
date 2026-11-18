import { z } from 'zod';
import type { JsonObject, JsonValue } from '../database/connection.js';

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
    status: z.enum(['completed', 'failed', 'cancelled']),
    usage: usageSchema.nullable(),
    durationMs: duration.optional(),
    firstTextMs: duration.optional(),
  }).strict()),
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
});

export const createSessionSchema = z.object({
  id: identifier.optional(), worldId: identifier, presetId: identifier,
  apiModelConfigId: identifier, userCharacterId: identifier,
  title: z.string().nullable().optional(), state: jsonObject.optional(),
}).strict();
export const updateSessionSchema = z.object({
  presetId: identifier.optional(), apiModelConfigId: identifier.optional(),
  userCharacterId: identifier.optional(), title: z.string().nullable().optional(),
}).strict();
const appendFields = {
  id: identifier.optional(), parentId: identifier.nullable().optional(), runId: identifier,
  timestamp: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  payload: jsonObject, state: jsonArray.nullable().optional(),
  extData: jsonObject.optional(), metrics: metricsSchema.nullable().optional(),
};
export const appendEntrySchema = z.discriminatedUnion('type', [
  z.object({ ...appendFields, type: z.literal('message'), role: z.enum(['user', 'assistant']) }).strict(),
  z.object({ ...appendFields, type: z.literal('compaction'), role: z.null() }).strict(),
]);
export const updateEntrySchema = z.object({
  payload: jsonObject.optional(), extData: jsonObject.optional(),
}).strict();
export const sessionListSchema = z.object({
  worldId: identifier.optional(),
  limit: z.number().int().min(1).max(1000).default(100),
  before: z.object({
    updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    id: identifier,
  }).strict().optional(),
}).strict();
export const entryListSchema = z.object({
  afterSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.number().int().min(1).max(1000).default(100),
}).strict();
