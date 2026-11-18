import type { z } from 'zod';
import type { JsonObject, JsonValue } from '../database/connection.js';
import type {
  appendEntrySchema, createSessionSchema, entryListSchema, metricsSchema,
  sessionListSchema, updateEntrySchema, updateSessionSchema,
} from './schema.js';

export type EntryMetrics = z.infer<typeof metricsSchema>;
export type SessionRecord = {
  id: string; world_id: string; preset_id: string; api_model_config_id: string;
  user_character_id: string; tip_entry_id: string | null; title: string | null;
  state: JsonObject; usage_json: JsonObject | null; created_at: number; updated_at: number;
};
export type EntryRecord = {
  id: string; session_id: string; parent_id: string | null; run_id: string; seq: number;
  timestamp: number; payload: JsonObject; state: JsonValue[] | null; ext_data: JsonObject;
  metrics_json: EntryMetrics | null; created_at: number; updated_at: number;
} & ({ type: 'message'; role: 'user' | 'assistant' } | { type: 'compaction'; role: null });

export type CreateSessionInput = z.infer<typeof createSessionSchema>;
export type UpdateSessionInput = z.infer<typeof updateSessionSchema>;
export type AppendEntryInput = z.infer<typeof appendEntrySchema>;
export type UpdateEntryInput = z.infer<typeof updateEntrySchema>;

export type SessionListOptions = z.input<typeof sessionListSchema>;
export type EntryListOptions = z.input<typeof entryListSchema>;
