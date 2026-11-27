import type { z } from 'zod';
import type { JsonObject, JsonValue } from '../../infrastructure/database/connection.js';
import type {
  appendEntrySchema, createSessionSchema, metricsSchema, runtimeConfigSchema,
  sessionListSchema, updateEntrySchema, updateSessionSchema, narrativeOutcomeSchema, narrativeStopReasonSchema, entryRunListSchema,
} from './schema.js';

export type EntryMetrics = z.infer<typeof metricsSchema>;
export type SessionRuntimeConfig = z.infer<typeof runtimeConfigSchema>;
export type Session = {
  id: string; worldId: string; runtimeConfig: SessionRuntimeConfig;
  userCharacterId: string; tipEntryId: string | null; title: string | null;
  state: JsonObject; createdAt: number; updatedAt: number;
};
export type SessionEntry = {
  id: string; sessionId: string; parentId: string | null; runId: string; seq: number;
  timestamp: number; payload: JsonObject; state: JsonValue[] | null; extData: JsonObject;
  metrics: EntryMetrics | null; createdAt: number; updatedAt: number;
} & ({ type: 'message'; role: 'user' | 'assistant' } | { type: 'compaction'; role: null });

export type SessionPage = { items: Session[]; hasMore: boolean };

export type CreateSessionInput = z.input<typeof createSessionSchema>;
export type UpdateSessionInput = z.infer<typeof updateSessionSchema>;
export type AppendEntryInput = z.infer<typeof appendEntrySchema>;
export type UpdateEntryInput = z.infer<typeof updateEntrySchema>;

export type SessionListOptions = z.input<typeof sessionListSchema>;

export type NarrativeStopReason = z.infer<typeof narrativeStopReasonSchema>;
export type NarrativeOutcome = z.infer<typeof narrativeOutcomeSchema>;
export type EntryRunListOptions = z.input<typeof entryRunListSchema>;
export type EntryRun = { runId: string; firstSeq: number; lastSeq: number; entries: SessionEntry[] };
export type EntryRunPage = { items: EntryRun[]; hasMore: boolean; nextBeforeSeq: number | null; nextAfterSeq: number | null };

export type DeletedEntry = { entry: SessionEntry; tipEntryId: string | null };
