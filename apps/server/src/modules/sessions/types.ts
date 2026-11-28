import type { z } from 'zod';
import type { JsonObject, JsonValue } from '../../infrastructure/database/connection.js';
import type {
  createSessionSchema, metricsSchema, runtimeConfigSchema, sessionListSchema, updateSessionSchema, narrativeStopReasonSchema,
} from './schema.js';

export type RequestMetrics = z.infer<typeof metricsSchema>;
export type SessionRuntimeConfig = z.infer<typeof runtimeConfigSchema>;
export type Session = {
  id: string; worldId: string; runtimeConfig: SessionRuntimeConfig;
  userCharacterId: string; tipEntryId: string | null; title: string | null;
  state: JsonObject; createdAt: number; updatedAt: number;
};
export type SessionEntry = {
  id: string; sessionId: string; parentId: string | null; runId: string; seq: number;
  timestamp: number; payload: JsonObject; state: JsonValue[] | null; extData: JsonObject;
  status: 'complete' | 'partial' | null; createdAt: number; updatedAt: number;
} & ({ type: 'message'; role: 'user' | 'assistant' } | { type: 'compaction'; role: null });

export type SessionPage = { items: Session[]; hasMore: boolean };

export type CreateSessionInput = z.input<typeof createSessionSchema>;
export type UpdateSessionInput = z.infer<typeof updateSessionSchema>;
export type SessionListOptions = z.input<typeof sessionListSchema>;

export type NarrativeStopReason = z.infer<typeof narrativeStopReasonSchema>;
