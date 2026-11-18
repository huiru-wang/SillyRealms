import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { encodeJson, transaction, type JsonObject, type JsonValue } from '../database/connection.js';
import { assertNarrativePreset } from '../presets/repository.js';

const identifier = z.string().min(1).refine(value => value === value.trim(), 'Identifiers cannot have surrounding whitespace');
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

const metricsSchema = z.object({
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

const createSessionSchema = z.object({
  id: identifier.optional(), world_id: identifier, preset_id: identifier,
  api_model_config_id: identifier, user_character_id: identifier,
  title: z.string().nullable().optional(), state: jsonObject.optional(),
}).strict();
const updateSessionSchema = z.object({
  preset_id: identifier.optional(), api_model_config_id: identifier.optional(),
  user_character_id: identifier.optional(), title: z.string().nullable().optional(),
}).strict();
const appendFields = {
  id: identifier.optional(), parent_id: identifier.nullable().optional(), run_id: identifier,
  timestamp: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  payload: jsonObject, state: jsonArray.nullable().optional(),
  ext_data: jsonObject.optional(), metrics_json: metricsSchema.nullable().optional(),
};
const appendEntrySchema = z.discriminatedUnion('type', [
  z.object({ ...appendFields, type: z.literal('message'), role: z.enum(['user', 'assistant']) }).strict(),
  z.object({ ...appendFields, type: z.literal('compaction'), role: z.null() }).strict(),
]);
const updateEntrySchema = z.object({
  payload: jsonObject.optional(), ext_data: jsonObject.optional(),
}).strict();
export type CreateSessionInput = z.infer<typeof createSessionSchema>;
export type UpdateSessionInput = z.infer<typeof updateSessionSchema>;
export type AppendEntryInput = z.infer<typeof appendEntrySchema>;
export type UpdateEntryInput = z.infer<typeof updateEntrySchema>;

function decodeSession(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id), world_id: String(row.world_id), preset_id: String(row.preset_id),
    api_model_config_id: String(row.api_model_config_id), user_character_id: String(row.user_character_id),
    tip_entry_id: row.tip_entry_id === null ? null : String(row.tip_entry_id),
    title: row.title === null ? null : String(row.title),
    state: JSON.parse(String(row.state)) as JsonObject,
    usage_json: row.usage_json === null ? null : JSON.parse(String(row.usage_json)) as JsonObject,
    created_at: Number(row.created_at), updated_at: Number(row.updated_at),
  };
}

function decodeEntry(row: Record<string, unknown>): EntryRecord {
  const kind: { type: 'message'; role: 'user' | 'assistant' } | { type: 'compaction'; role: null } | null =
    row.type === 'message' && (row.role === 'user' || row.role === 'assistant')
    ? { type: 'message' as const, role: row.role }
    : row.type === 'compaction' && row.role === null
      ? { type: 'compaction' as const, role: null }
      : null;
  if (!kind) throw new Error('INVALID_ENTRY_TYPE');
  return {
    ...kind,
    id: String(row.id), session_id: String(row.session_id),
    parent_id: row.parent_id === null ? null : String(row.parent_id),
    run_id: String(row.run_id), seq: Number(row.seq), timestamp: Number(row.timestamp),
    payload: JSON.parse(String(row.payload)) as JsonObject,
    state: row.state === null ? null : JSON.parse(String(row.state)) as JsonValue[],
    ext_data: JSON.parse(String(row.ext_data)) as JsonObject,
    metrics_json: row.metrics_json === null ? null : metricsSchema.parse(JSON.parse(String(row.metrics_json))),
    created_at: Number(row.created_at), updated_at: Number(row.updated_at),
  };
}

function pageLimit(limit: number | undefined): number {
  return z.number().int().min(1).max(1000).parse(limit ?? 100);
}

/** Content/history persistence only. State and request metrics have separate writes. */
export class SessionRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(id: string): SessionRecord | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(identifier.parse(id));
    return row ? decodeSession(row) : null;
  }

  create(input: CreateSessionInput): SessionRecord {
    const value = createSessionSchema.parse(input);
    const state = encodeJson(value.state ?? {}, 'object');
    return transaction(this.db, () => {
      assertNarrativePreset(this.db, value.preset_id);
      if (!this.db.prepare('SELECT 1 FROM worlds WHERE id=?').get(value.world_id)) throw new Error('WORLD_NOT_FOUND');
      this.assertModel(value.api_model_config_id);
      const id = value.id ?? randomUUID(), now = Date.now();
      this.db.prepare(
        'INSERT INTO sessions(id,world_id,preset_id,api_model_config_id,user_character_id,tip_entry_id,title,state,usage_json,created_at,updated_at) ' +
        'VALUES(?,?,?,?,?,NULL,?,?,NULL,?,?)',
      ).run(id, value.world_id, value.preset_id, value.api_model_config_id, value.user_character_id, value.title ?? null, state, now, now);
      return this.requireSession(id);
    });
  }

  list(options: { world_id?: string; limit?: number; before?: { updated_at: number; id: string } } = {}): SessionRecord[] {
    const limit = pageLimit(options.limit), clauses: string[] = [], values: (string | number)[] = [];
    if (options.world_id !== undefined) {
      clauses.push('world_id=?'); values.push(identifier.parse(options.world_id));
    }
    if (options.before !== undefined) {
      const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(options.before.updated_at);
      clauses.push('(updated_at<? OR (updated_at=? AND id<?))');
      values.push(time, time, identifier.parse(options.before.id));
    }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    return this.db.prepare('SELECT * FROM sessions' + where + ' ORDER BY updated_at DESC,id DESC LIMIT ?')
      .all(...values, limit).map(decodeSession);
  }

  update(id: string, input: UpdateSessionInput): SessionRecord {
    const patch = updateSessionSchema.parse(input);
    return transaction(this.db, () => {
      const current = this.requireSession(id);
      if (!Object.values(patch).some(value => value !== undefined)) return current;
      const preset = patch.preset_id ?? current.preset_id, model = patch.api_model_config_id ?? current.api_model_config_id;
      assertNarrativePreset(this.db, preset); this.assertModel(model);
      this.db.prepare('UPDATE sessions SET preset_id=?,api_model_config_id=?,user_character_id=?,title=?,updated_at=? WHERE id=?')
        .run(preset, model, patch.user_character_id ?? current.user_character_id,
          patch.title !== undefined ? patch.title : current.title, Date.now(), id);
      return this.requireSession(id);
    });
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM sessions WHERE id=?').run(identifier.parse(id)).changes > 0;
  }

  getEntry(sessionId: string, entryId: string): EntryRecord | null {
    const row = this.db.prepare('SELECT * FROM entries WHERE session_id=? AND id=?')
      .get(identifier.parse(sessionId), identifier.parse(entryId));
    return row ? decodeEntry(row) : null;
  }

  appendEntry(sessionId: string, input: AppendEntryInput): EntryRecord {
    const value = appendEntrySchema.parse(input);
    const payload = encodeJson(value.payload, 'object'), ext = encodeJson(value.ext_data ?? {}, 'object');
    const state = value.state == null ? null : encodeJson(value.state, 'array');
    const metrics = value.metrics_json ?? null;
    return transaction(this.db, () => {
      const session = this.requireSession(sessionId), id = value.id ?? randomUUID();
      const parent = value.parent_id === undefined ? session.tip_entry_id : value.parent_id;
      const maximum = Number(this.db.prepare('SELECT coalesce(max(seq),0) AS seq FROM entries WHERE session_id=?').get(sessionId)!.seq);
      if (parent !== null) this.readAncestors(sessionId, parent);
      else if (maximum !== 0) throw new Error('INVALID_PARENT_CHAIN: a nonempty session requires a parent');
      this.assertMetrics(sessionId, id, value.type === 'message' ? value.role : null, metrics);
      const now = Date.now();
      this.db.prepare(
        'INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,timestamp,payload,state,ext_data,metrics_json,created_at,updated_at) ' +
        'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(id, sessionId, parent, value.run_id, maximum + 1, value.type, value.role, value.timestamp ?? now,
        payload, state, ext, metrics === null ? null : encodeJson(metrics, 'object'), now, now);
      this.db.prepare('UPDATE sessions SET tip_entry_id=?,updated_at=? WHERE id=?').run(id, now, sessionId);
      return this.requireEntry(sessionId, id);
    });
  }

  listEntries(sessionId: string, options: { after_seq?: number; limit?: number } = {}): EntryRecord[] {
    this.requireSession(sessionId);
    const after = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(options.after_seq ?? 0);
    return this.db.prepare('SELECT * FROM entries WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?')
      .all(sessionId, after, pageLimit(options.limit)).map(decodeEntry);
  }

  listRunEntries(sessionId: string, runId: string): EntryRecord[] {
    this.requireSession(sessionId);
    return this.db.prepare('SELECT * FROM entries WHERE session_id=? AND run_id=? ORDER BY seq')
      .all(sessionId, identifier.parse(runId)).map(decodeEntry);
  }

  getHistory(sessionId: string, tipId?: string | null): EntryRecord[] {
    const session = this.requireSession(sessionId);
    const tip = tipId === undefined ? session.tip_entry_id : tipId;
    return tip === null ? [] : this.readAncestors(sessionId, identifier.parse(tip));
  }

  setTip(sessionId: string, entryId: string): SessionRecord {
    return transaction(this.db, () => {
      this.requireSession(sessionId);
      this.readAncestors(sessionId, identifier.parse(entryId));
      this.db.prepare('UPDATE sessions SET tip_entry_id=?,updated_at=? WHERE id=?').run(entryId, Date.now(), sessionId);
      return this.requireSession(sessionId);
    });
  }

  updateEntry(sessionId: string, entryId: string, input: UpdateEntryInput): EntryRecord {
    const patch = updateEntrySchema.parse(input);
    return transaction(this.db, () => {
      const current = this.requireEntry(sessionId, entryId);
      if (patch.payload === undefined && patch.ext_data === undefined) return current;
      const payload = encodeJson(patch.payload ?? current.payload, 'object');
      const ext = encodeJson(patch.ext_data ?? current.ext_data, 'object');
      const now = Date.now();
      this.db.prepare('UPDATE entries SET payload=?,ext_data=?,updated_at=? WHERE session_id=? AND id=?')
        .run(payload, ext, now, sessionId, entryId);
      this.db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(now, sessionId);
      return this.requireEntry(sessionId, entryId);
    });
  }

  /** NULL means no record; usage:null means an actual request whose usage was not reported. */
  setMetrics(sessionId: string, entryId: string, value: EntryMetrics | null): EntryRecord {
    const metrics = value === null ? null : metricsSchema.parse(value);
    return transaction(this.db, () => {
      const current = this.requireEntry(sessionId, entryId);
      this.assertMetrics(sessionId, entryId, current.role, metrics);
      // A metadata update changes updated_at, never the displayed message timestamp or session ordering.
      this.db.prepare('UPDATE entries SET metrics_json=?,updated_at=? WHERE session_id=? AND id=?')
        .run(metrics === null ? null : encodeJson(metrics, 'object'), Date.now(), sessionId, entryId);
      return this.requireEntry(sessionId, entryId);
    });
  }

  private requireSession(id: string): SessionRecord {
    const row = this.get(id);
    if (!row) throw new Error('SESSION_NOT_FOUND');
    return row;
  }

  private requireEntry(sessionId: string, entryId: string): EntryRecord {
    const row = this.getEntry(sessionId, entryId);
    if (!row) throw new Error('ENTRY_NOT_FOUND');
    return row;
  }

  private assertModel(id: string): void {
    if (!this.db.prepare('SELECT 1 FROM api_model_configs WHERE id=?').get(id)) throw new Error('MODEL_NOT_FOUND');
  }

  private readAncestors(sessionId: string, tip: string): EntryRecord[] {
    const result: EntryRecord[] = [], visited = new Set<string>();
    let current: string | null = tip, nextSequence = Infinity;
    while (current !== null) {
      if (visited.has(current)) throw new Error('INVALID_PARENT_CHAIN: cycle');
      visited.add(current);
      const row = this.getEntry(sessionId, current);
      if (!row || row.seq >= nextSequence) throw new Error('INVALID_PARENT_CHAIN');
      result.push(row); current = row.parent_id; nextSequence = row.seq;
    }
    return result.reverse();
  }

  private assertMetrics(sessionId: string, entryId: string, role: EntryRecord['role'], metrics: EntryMetrics | null): void {
    if (metrics === null) return;
    if (role === 'user') throw new Error('USER_ENTRY_METRICS_NOT_ALLOWED');
    // Keep one canonical owner for each model request within a session, including inactive branches.
    const duplicate = this.db.prepare(
      "SELECT e.id FROM entries e, json_each(e.metrics_json,'$.requests') AS request " +
      "WHERE e.session_id=? AND e.id<>? AND json_extract(request.value,'$.requestId')=? LIMIT 1",
    );
    for (const request of metrics.requests) {
      if (duplicate.get(sessionId, entryId, request.requestId)) throw new Error('DUPLICATE_REQUEST_METRICS');
    }
  }
}
