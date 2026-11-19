import type { z } from 'zod';
import type { JsonObject, JsonValue } from '../../infrastructure/database/connection.js';
import type {
  appendEntrySchema, createSessionSchema, entryListSchema, metricsSchema,
  sessionListSchema, updateEntrySchema, updateSessionSchema,
} from './schema.js';

export type EntryMetrics = z.infer<typeof metricsSchema>;
export type Session = {
  id: string; worldId: string; presetId: string; apiModelConfigId: string;
  userCharacterId: string; tipEntryId: string | null; title: string | null;
  state: JsonObject; usage: JsonObject | null; createdAt: number; updatedAt: number;
};
export type SessionEntry = {
  id: string; sessionId: string; parentId: string | null; runId: string; seq: number;
  timestamp: number; payload: JsonObject; state: JsonValue[] | null; extData: JsonObject;
  metrics: EntryMetrics | null; createdAt: number; updatedAt: number;
} & ({ type: 'message'; role: 'user' | 'assistant' } | { type: 'compaction'; role: null });

export type SessionPage = { items: Session[]; hasMore: boolean };

export type CreateSessionInput = z.infer<typeof createSessionSchema>;
export type UpdateSessionInput = z.infer<typeof updateSessionSchema>;
export type AppendEntryInput = z.infer<typeof appendEntrySchema>;
export type UpdateEntryInput = z.infer<typeof updateEntrySchema>;

export type SessionListOptions = z.input<typeof sessionListSchema>;
export type EntryListOptions = z.input<typeof entryListSchema>;
