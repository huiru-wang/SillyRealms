import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { JsonObject, JsonValue } from '../../infrastructure/database/connection.js';
import { metricsSchema, narrativeStopReasonSchema, validateMessagePayload } from './schema.js';
import { storedNarrativeOutputSchema, type NarrativeOutput } from './output.js';
import type { RequestMetrics, SessionEntry } from './types.js';

export const runMetricsSchema = z.object({
  main: metricsSchema.nullable(),
  summaries: z.record(z.string(), metricsSchema),
}).strict();
export type RunMetrics = z.infer<typeof runMetricsSchema>;
export const runOptionsSchema = z.object({
  limit: z.number().int().min(1).max(5).optional(),
  beforePageKey: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();
export type RunOptions = z.infer<typeof runOptionsSchema>;
export type Capabilities = Partial<NarrativeOutput>;
export type MessageInput = {
  id: string; parentId: string | null; timestamp: number; payload: JsonObject; state?: JsonValue[] | null;
};
export type SummaryInput = {
  id: string; parentId: string; runId: string; text: string; coveredThroughEntryId: string; sourceHash: string;
  metrics: RequestMetrics | null;
};
export function publicMessage(entry: SessionEntry) {
  if (entry.type !== 'message' || !entry.status) throw new AppError('INVALID_ENTRY_TYPE');
  const message = validateMessagePayload(entry.payload, entry.role);
  return { id: entry.id, status: entry.status, ...message };
}
export type RunMessage = ReturnType<typeof publicMessage>;
export function aggregateUsage(records: Iterable<RunMetrics>) {
  const knownUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let recordedRequestCount = 0, unknownUsageRequestCount = 0;
  const seen = new Set<string>();
  for (const record of records) {
    for (const metrics of [record.main, ...Object.values(record.summaries)]) {
      for (const request of metrics?.requests ?? []) {
        if (seen.has(request.requestId)) throw new AppError('DUPLICATE_REQUEST_METRICS');
        seen.add(request.requestId);
        recordedRequestCount++;
        if (!request.usage) { unknownUsageRequestCount++; continue; }
        for (const key of Object.keys(knownUsage) as Array<keyof typeof knownUsage>) knownUsage[key] += request.usage[key];
      }
    }
  }
  return { knownUsage, recordedRequestCount, unknownUsageRequestCount };
}
export type RunUsage = ReturnType<typeof aggregateUsage>;
const runStatus = z.enum(['running', 'stopping', 'completed', 'stopped']);
export function decodeMetrics(raw: unknown): RunMetrics {
  try { return runMetricsSchema.parse(JSON.parse(String(raw))); }
  catch { throw new AppError('INTERNAL_ERROR', 'Invalid stored request metrics'); }
}

export function decodeRun(row: Record<string, unknown>) {
  try {
    return {
      id: String(row.id), assistantEntryId: String(row.assistant_entry_id), pageKey: Number(row.page_key),
      status: runStatus.parse(row.status), stopReason: narrativeStopReasonSchema.nullable().parse(row.stop_reason),
      createdAt: Number(row.created_at), finishedAt: row.finished_at === null ? null : Number(row.finished_at),
      capabilities: decodeCapabilities(row.capabilities_json),
      metrics: decodeMetrics(row.metrics_json),
    };
  } catch {
    throw new AppError('INTERNAL_ERROR', 'Invalid stored run: ' + String(row.id));
  }
}
const storedCapabilities = storedNarrativeOutputSchema.partial();

export function decodeCapabilities(raw: unknown): Capabilities {
  return storedCapabilities.parse(JSON.parse(String(raw)));
}
