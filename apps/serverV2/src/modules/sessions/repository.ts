import { transaction } from '../../infrastructure/database/transaction.js';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../../errors.js';
import { encodeJson, type JsonObject, type JsonValue } from '../../infrastructure/database/connection.js';
import type {
  AppendEntryInput, CreateSessionInput, EntryListOptions, EntryMetrics,
  SessionListOptions, UpdateEntryInput, UpdateSessionInput,
} from './types.js';

export type SessionRow = {
  id: string; world_id: string; preset_id: string; api_model_config_id: string;
  user_character_id: string; tip_entry_id: string | null; title: string | null;
  state: JsonObject; usage_json: JsonObject | null; created_at: number; updated_at: number;
};
export type EntryRow = {
  id: string; session_id: string; parent_id: string | null; run_id: string; seq: number;
  timestamp: number; payload: JsonObject; state: JsonValue[] | null; ext_data: JsonObject;
  metrics_json: EntryMetrics | null; created_at: number; updated_at: number;
} & ({ type: 'message'; role: 'user' | 'assistant' } | { type: 'compaction'; role: null });

function decodeSession(row: Record<string, unknown>): SessionRow {
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

function decodeEntry(row: Record<string, unknown>): EntryRow {
  const kind: { type: 'message'; role: 'user' | 'assistant' } | { type: 'compaction'; role: null } | null =
    row.type === 'message' && (row.role === 'user' || row.role === 'assistant')
    ? { type: 'message' as const, role: row.role }
    : row.type === 'compaction' && row.role === null
      ? { type: 'compaction' as const, role: null }
      : null;
  if (!kind) throw new AppError('INVALID_ENTRY_TYPE');
  return {
    ...kind,
    id: String(row.id), session_id: String(row.session_id),
    parent_id: row.parent_id === null ? null : String(row.parent_id),
    run_id: String(row.run_id), seq: Number(row.seq), timestamp: Number(row.timestamp),
    payload: JSON.parse(String(row.payload)) as JsonObject,
    state: row.state === null ? null : JSON.parse(String(row.state)) as JsonValue[],
    ext_data: JSON.parse(String(row.ext_data)) as JsonObject,
    metrics_json: row.metrics_json === null ? null : JSON.parse(String(row.metrics_json)) as EntryMetrics,
    created_at: Number(row.created_at), updated_at: Number(row.updated_at),
  };
}

/** Module-private persistence for sessions and entries only. */
export class SessionRepository {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) { this.#db = db; }

  get(id: string): SessionRow | null {
    const row = this.#db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
    return row ? decodeSession(row) : null;
  }

  create(value: CreateSessionInput & { id: string }): SessionRow {
    const state = encodeJson(value.state ?? {}, 'object');
    const now = Date.now();
    this.#db.prepare(
      'INSERT INTO sessions(id,world_id,preset_id,api_model_config_id,user_character_id,tip_entry_id,title,state,usage_json,created_at,updated_at) ' +
      'VALUES(?,?,?,?,?,NULL,?,?,NULL,?,?)',
    ).run(value.id, value.worldId, value.presetId, value.apiModelConfigId, value.userCharacterId, value.title ?? null, state, now, now);
    return this.#requireSession(value.id);
  }

  list(options: SessionListOptions & { limit: number }): SessionRow[] {
    const clauses: string[] = [], values: (string | number)[] = [];
    if (options.worldId !== undefined) {
      clauses.push('world_id=?'); values.push(options.worldId);
    }
    if (options.before !== undefined) {
      clauses.push('(updated_at<? OR (updated_at=? AND id<?))');
      values.push(options.before.updatedAt, options.before.updatedAt, options.before.id);
    }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    return this.#db.prepare('SELECT * FROM sessions' + where + ' ORDER BY updated_at DESC,id DESC LIMIT ?')
      .all(...values, options.limit).map(decodeSession);
  }

  listPage(options: SessionListOptions & { limit: number }): { items: SessionRow[]; hasMore: boolean } {
    const rows = this.list({ ...options, limit: options.limit + 1 });
    return { items: rows.slice(0, options.limit), hasMore: rows.length > options.limit };
  }

  countByWorldIds(worldIds: readonly string[]): Record<string, number> {
    const result = Object.fromEntries(worldIds.map(id => [id, 0]));
    for (let offset = 0; offset < worldIds.length; offset += 500) {
      const batch = worldIds.slice(offset, offset + 500);
      const placeholders = batch.map(() => '?').join(',');
      const rows = this.#db.prepare(
        'SELECT world_id,count(*) AS count FROM sessions WHERE world_id IN (' + placeholders + ') GROUP BY world_id',
      ).all(...batch);
      for (const row of rows) result[String(row.world_id)] = Number(row.count);
    }
    return result;
  }

  update(id: string, patch: UpdateSessionInput): SessionRow {
    return transaction(this.#db, () => {
      const current = this.#requireSession(id);
      if (!Object.values(patch).some(value => value !== undefined)) return current;
      this.#db.prepare('UPDATE sessions SET preset_id=?,api_model_config_id=?,title=?,updated_at=? WHERE id=?')
        .run(patch.presetId ?? current.preset_id, patch.apiModelConfigId ?? current.api_model_config_id,
          patch.title !== undefined ? patch.title : current.title, Date.now(), id);
      return this.#requireSession(id);
    });
  }

  delete(id: string): boolean {
    return this.#db.prepare('DELETE FROM sessions WHERE id=?').run(id).changes > 0;
  }

  getEntry(sessionId: string, entryId: string): EntryRow | null {
    const row = this.#db.prepare('SELECT * FROM entries WHERE session_id=? AND id=?').get(sessionId, entryId);
    return row ? decodeEntry(row) : null;
  }

  /** Check the expected predecessor and advance the tip with the insertion in one transaction. */
  appendEntry(sessionId: string, value: AppendEntryInput & { id: string }): EntryRow {
    const payload = encodeJson(value.payload, 'object'), ext = encodeJson(value.extData ?? {}, 'object');
    const state = value.state == null ? null : encodeJson(value.state, 'array');
    const metrics = value.metrics ?? null;
    return transaction(this.#db, () => {
      const session = this.#requireSession(sessionId);
      const parent = value.parentId === undefined ? session.tip_entry_id : value.parentId;
      if (parent !== session.tip_entry_id) throw new AppError('TIP_CONFLICT');
      const maximum = Number(this.#db.prepare('SELECT coalesce(max(seq),0) AS seq FROM entries WHERE session_id=?').get(sessionId)!.seq);
      if (parent === null ? maximum !== 0 : this.getEntry(sessionId, parent)?.seq !== maximum) {
        throw new AppError('INVALID_PARENT_CHAIN');
      }
      this.#assertMetricsUnique(sessionId, value.id, metrics);
      const now = Date.now();
      this.#db.prepare(
        'INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,timestamp,payload,state,ext_data,metrics_json,created_at,updated_at) ' +
        'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(value.id, sessionId, parent, value.runId, maximum + 1, value.type, value.role, value.timestamp ?? now,
        payload, state, ext, metrics === null ? null : encodeJson(metrics, 'object'), now, now);
      this.#db.prepare('UPDATE sessions SET tip_entry_id=?,updated_at=? WHERE id=?').run(value.id, now, sessionId);
      return this.#requireEntry(sessionId, value.id);
    });
  }

  listEntries(sessionId: string, options: Required<EntryListOptions>): EntryRow[] {
    return this.#db.prepare('SELECT * FROM entries WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?')
      .all(sessionId, options.afterSeq, options.limit).map(decodeEntry);
  }

  listRunEntries(sessionId: string, runId: string): EntryRow[] {
    return this.#db.prepare('SELECT * FROM entries WHERE session_id=? AND run_id=? ORDER BY seq')
      .all(sessionId, runId).map(decodeEntry);
  }

  updateEntry(sessionId: string, entryId: string, patch: UpdateEntryInput): EntryRow {
    return transaction(this.#db, () => {
      const current = this.#requireEntry(sessionId, entryId);
      if (patch.payload === undefined && patch.extData === undefined) return current;
      const payload = encodeJson(patch.payload ?? current.payload, 'object');
      const ext = encodeJson(patch.extData ?? current.ext_data, 'object');
      const now = Date.now();
      this.#db.prepare('UPDATE entries SET payload=?,ext_data=?,updated_at=? WHERE session_id=? AND id=?')
        .run(payload, ext, now, sessionId, entryId);
      this.#db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(now, sessionId);
      return this.#requireEntry(sessionId, entryId);
    });
  }

  setMetrics(sessionId: string, entryId: string, value: EntryMetrics | null): EntryRow {
    return transaction(this.#db, () => {
      this.#requireEntry(sessionId, entryId);
      this.#assertMetricsUnique(sessionId, entryId, value);
      this.#db.prepare('UPDATE entries SET metrics_json=?,updated_at=? WHERE session_id=? AND id=?')
        .run(value === null ? null : encodeJson(value, 'object'), Date.now(), sessionId, entryId);
      return this.#requireEntry(sessionId, entryId);
    });
  }

  #assertMetricsUnique(sessionId: string, entryId: string, metrics: EntryMetrics | null): void {
    if (metrics === null) return;
    const select = this.#db.prepare(
      "SELECT e.id FROM entries e, json_each(e.metrics_json,'$.requests') AS request " +
      "WHERE e.session_id=? AND e.id<>? AND json_extract(request.value,'$.requestId')=? LIMIT 1",
    );
    for (const request of metrics.requests) {
      if (select.get(sessionId, entryId, request.requestId)) throw new AppError('DUPLICATE_REQUEST_METRICS');
    }
  }

  getState(sessionId: string): JsonObject | null {
    const row = this.#db.prepare('SELECT state FROM sessions WHERE id=?').get(sessionId);
    return row ? JSON.parse(String(row.state)) as JsonObject : null;
  }

  setState(sessionId: string, value: JsonObject): JsonObject {
    const state = encodeJson(value, 'object');
    const result = this.#db.prepare('UPDATE sessions SET state=?,updated_at=? WHERE id=?')
      .run(state, Date.now(), sessionId);
    if (!result.changes) throw new AppError('SESSION_NOT_FOUND');
    return JSON.parse(state) as JsonObject;
  }

  getEntryState(sessionId: string, entryId: string): JsonValue[] | null {
    const row = this.#db.prepare('SELECT state FROM entries WHERE session_id=? AND id=?').get(sessionId, entryId);
    return !row || row.state === null ? null : JSON.parse(String(row.state)) as JsonValue[];
  }

  setEntryState(sessionId: string, entryId: string, value: JsonValue[] | null): JsonValue[] | null {
    const state = value === null ? null : encodeJson(value, 'array');
    const result = this.#db.prepare('UPDATE entries SET state=?,updated_at=? WHERE session_id=? AND id=?')
      .run(state, Date.now(), sessionId, entryId);
    if (!result.changes) throw new AppError('ENTRY_NOT_FOUND');
    return state === null ? null : JSON.parse(state) as JsonValue[];
  }

  #requireSession(id: string): SessionRow {
    const row = this.get(id);
    if (!row) throw new AppError('SESSION_NOT_FOUND');
    return row;
  }

  #requireEntry(sessionId: string, entryId: string): EntryRow {
    const row = this.getEntry(sessionId, entryId);
    if (!row) throw new AppError('ENTRY_NOT_FOUND');
    return row;
  }
}
