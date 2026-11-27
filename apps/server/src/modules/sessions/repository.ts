import { transaction } from '../../infrastructure/database/transaction.js';
import type { DatabaseSync } from 'node:sqlite';
import { metricsSchema, runtimeConfigSchema, validateMessagePayload } from './schema.js';
import { AppError } from '../../errors.js';
import { encodeJson, type JsonObject, type JsonValue } from '../../infrastructure/database/connection.js';
import type {
  AppendEntryInput, CreateSessionInput, SessionRuntimeConfig, EntryMetrics,
  SessionListOptions, UpdateEntryInput, UpdateSessionInput, EntryRunListOptions, NarrativeOutcome,
} from './types.js';

export type SessionRow = {
  id: string; world_id: string; runtime_config: SessionRuntimeConfig;
  user_character_id: string; tip_entry_id: string | null; title: string | null;
  state: JsonObject; created_at: number; updated_at: number;
};
export type EntryRow = {
  id: string; session_id: string; parent_id: string | null; run_id: string; seq: number;
  timestamp: number; payload: JsonObject; state: JsonValue[] | null; ext_data: JsonObject;
  metrics_json: EntryMetrics | null; created_at: number; updated_at: number;
} & ({ type: 'message'; role: 'user' | 'assistant' } | { type: 'compaction'; role: null });

function encodeConfig(config: SessionRuntimeConfig) {
  return encodeJson({
    narrative_preset_id: config.narrativePresetId, api_model_config_id: config.apiModelConfigId,
    reply_assist_preset_id: config.replyAssistPresetId, reply_assist_goal: config.replyAssistGoal,
    font_size: config.fontSize,
  }, 'object');
}

function decodeSession(row: Record<string, unknown>): SessionRow {
  const config = JSON.parse(String(row.runtime_config));
  return {
    id: String(row.id), world_id: String(row.world_id), user_character_id: String(row.user_character_id),
    runtime_config: runtimeConfigSchema.parse({
      narrativePresetId: config.narrative_preset_id, apiModelConfigId: config.api_model_config_id,
      replyAssistPresetId: config.reply_assist_preset_id, replyAssistGoal: config.reply_assist_goal,
      fontSize: config.font_size,
    }),
    tip_entry_id: row.tip_entry_id === null ? null : String(row.tip_entry_id),
    title: row.title === null ? null : String(row.title),
    state: JSON.parse(String(row.state)) as JsonObject,
    created_at: Number(row.created_at), updated_at: Number(row.updated_at),
  };
}

function decodeMetrics(json: unknown): EntryMetrics {
  const parsed = metricsSchema.safeParse(JSON.parse(String(json)));
  if (!parsed.success) throw new AppError('INTERNAL_ERROR', 'Invalid stored entry metrics');
  return parsed.data;
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
    metrics_json: row.metrics_json === null ? null : decodeMetrics(row.metrics_json),
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

  create(value: CreateSessionInput & { id: string; runtimeConfig: SessionRuntimeConfig }): SessionRow {
    const state = encodeJson(value.state ?? {}, 'object');
    const now = Date.now();
    this.#db.prepare(
      'INSERT INTO sessions(id,world_id,runtime_config,user_character_id,tip_entry_id,title,state,created_at,updated_at) ' +
      'VALUES(?,?,?,?,NULL,?,?,?,?)',
    ).run(value.id, value.worldId, encodeConfig(value.runtimeConfig), value.userCharacterId, value.title ?? null, state, now, now);
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

  listUsingPreset(presetId: string, type: 'narrative' | 'reply_assist') {
    const column = type === 'reply_assist' ? 'reply_preset_ref' : 'narrative_preset_ref';
    return this.#db.prepare('SELECT id, title FROM sessions WHERE ' + column + ' = ? ORDER BY title, id')
      .all(presetId).map(row => ({ id: String(row.id), name: row.title === null ? null : String(row.title) }));
  }

  listIdsByWorld(worldId: string): string[] {
    return this.#db.prepare('SELECT id FROM sessions WHERE world_id=? ORDER BY id').all(worldId).map(row => String(row.id));
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
      const config = runtimeConfigSchema.parse({ ...current.runtime_config, ...patch.runtimeConfig });
      this.#db.prepare('UPDATE sessions SET runtime_config=?,title=?,updated_at=? WHERE id=?')
        .run(encodeConfig(config), patch.title === undefined ? current.title : patch.title, Date.now(), id);
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
    if (value.type === 'message') validateMessagePayload(JSON.parse(payload), value.role);
    const state = value.state == null ? null : encodeJson(value.state, 'array');
    const metrics = value.metrics ?? null;
    return transaction(this.#db, () => {
      const session = this.#requireSession(sessionId);
      const parent = value.parentId === undefined ? session.tip_entry_id : value.parentId;
      if (parent !== session.tip_entry_id) throw new AppError('TIP_CONFLICT');
      const latest = this.#db.prepare('SELECT id,seq FROM entries WHERE session_id=? ORDER BY seq DESC LIMIT 1').get(sessionId);
      if (parent !== (latest?.id ?? null)) throw new AppError('INVALID_PARENT_CHAIN');
      const seq = Number(latest?.seq ?? 0) + 1;
      this.#assertMetricsUnique(sessionId, metrics);
      const now = Date.now();
      this.#db.prepare(
        'INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,timestamp,payload,state,ext_data,metrics_json,created_at,updated_at) ' +
        'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(value.id, sessionId, parent, value.runId, seq, value.type, value.role, value.timestamp ?? now,
        payload, state, ext, metrics === null ? null : encodeJson(metrics, 'object'), now, now);
      this.#db.prepare('UPDATE sessions SET tip_entry_id=?,updated_at=? WHERE id=?').run(value.id, now, sessionId);
      return this.#requireEntry(sessionId, value.id);
    });
  }

  contextEntries(sessionId: string, tipId: string): EntryRow[] {
    return this.#db.prepare('SELECT * FROM entries WHERE session_id=? AND seq <= ' +
      '(SELECT seq FROM entries WHERE session_id=? AND id=?) ORDER BY seq')
      .all(sessionId, sessionId, tipId).map(decodeEntry);
  }

  inheritedEntryState(sessionId: string, entryId: string): JsonValue[] | null | undefined {
    const row = this.#db.prepare('SELECT (SELECT state FROM entries WHERE session_id=target.session_id ' +
      'AND seq<=target.seq AND state IS NOT NULL ORDER BY seq DESC LIMIT 1) AS state ' +
      'FROM entries AS target WHERE target.session_id=? AND target.id=?').get(sessionId, entryId);
    if (!row) return undefined;
    return row.state === null ? null : JSON.parse(String(row.state)) as JsonValue[];
  }

  listEntryRuns(sessionId: string, options: EntryRunListOptions) {
    const limit = options.limit ?? 5;
    const forward = options.afterSeq !== undefined;
    // Seek from the cursor and select one boundary entry per run using (session_id,run_id,seq).
    const comparison = forward ? '>' : '<';
    const boundary = forward ? 'MAX' : 'MIN';
    const groups = this.#db.prepare(
      'SELECT e.run_id FROM entries e WHERE e.session_id=? AND e.seq' + comparison + '? AND e.seq=(' +
      'SELECT ' + boundary + '(r.seq) FROM entries r WHERE r.session_id=e.session_id AND r.run_id=e.run_id) ' +
      'ORDER BY e.seq ' + (forward ? 'ASC' : 'DESC') + ' LIMIT ?',
    ).all(sessionId, forward ? options.afterSeq! : options.beforeSeq ?? Number.MAX_SAFE_INTEGER, limit + 1);
    const selected = groups.slice(0, limit);
    if (!selected.length) return { items: [], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null };
    const entries = this.#db.prepare('SELECT * FROM entries WHERE session_id=? AND run_id IN (' +
      selected.map(() => '?').join(',') + ') ORDER BY seq').all(sessionId, ...selected.map(row => String(row.run_id))).map(decodeEntry);
    const items = selected.map(row => {
      const runEntries = entries.filter(entry => entry.run_id === row.run_id);
      return { runId: String(row.run_id), firstSeq: runEntries[0]!.seq, lastSeq: runEntries.at(-1)!.seq, entries: runEntries };
    });
    // A run may gain another entry later; forward progress is its last saved seq, never its first seq.
    return { items, hasMore: groups.length > limit,
      nextBeforeSeq: forward || groups.length <= limit ? null : items.at(-1)!.firstSeq,
      nextAfterSeq: Math.max(...items.map(item => item.lastSeq)) };
  }

  listMetrics(sessionId: string): EntryMetrics[] {
    return this.#db.prepare('SELECT metrics_json FROM entries WHERE session_id=? AND metrics_json IS NOT NULL')
      .all(sessionId).map(row => decodeMetrics(row.metrics_json));
  }

  latestNarrativeMetrics(sessionId: string): { seq: number; metrics: EntryMetrics } | null {
    const row = this.#db.prepare(
      "SELECT seq,metrics_json FROM entries WHERE session_id=? AND type='message' AND role='assistant' " +
      "AND metrics_json IS NOT NULL AND json_array_length(metrics_json,'$.requests')>0 ORDER BY seq DESC LIMIT 1",
    ).get(sessionId);
    return row ? { seq: Number(row.seq), metrics: decodeMetrics(row.metrics_json) } : null;
  }

  deleteEntry(sessionId: string, entryId: string, expectedTipEntryId: string | null) {
    return transaction(this.#db, () => {
      const session = this.#requireSession(sessionId);
      if (session.tip_entry_id !== expectedTipEntryId) throw new AppError('TIP_CONFLICT');
      const entry = this.#requireEntry(sessionId, entryId), now = Date.now();
      this.#db.prepare('UPDATE entries SET parent_id=?,updated_at=? WHERE session_id=? AND parent_id=?')
        .run(entry.parent_id, now, sessionId, entryId);
      this.#db.prepare('DELETE FROM entries WHERE session_id=? AND id=?').run(sessionId, entryId);
      const tipEntryId = session.tip_entry_id === entryId ? entry.parent_id : session.tip_entry_id;
      this.#db.prepare('UPDATE sessions SET tip_entry_id=?,updated_at=? WHERE id=?').run(tipEntryId, now, sessionId);
      return { entry, tipEntryId };
    });
  }

  setNarrativeOutcome(sessionId: string, entryId: string, outcome: NarrativeOutcome | null): EntryRow {
    return transaction(this.#db, () => {
      const current = this.#requireEntry(sessionId, entryId);
      const first = this.#db.prepare('SELECT id FROM entries WHERE session_id=? AND run_id=? ORDER BY seq LIMIT 1').get(sessionId, current.run_id);
      if (current.type !== 'message' || first?.id !== current.id) throw new AppError('INVALID_REQUEST', '结束结果只能保存在该 run 的首条消息');
      const ext = { ...current.ext_data };
      if (outcome === null) delete ext.narrative; else ext.narrative = outcome;
      this.#db.prepare('UPDATE entries SET ext_data=?,updated_at=? WHERE session_id=? AND id=?')
        .run(encodeJson(ext, 'object'), Date.now(), sessionId, entryId);
      return this.#requireEntry(sessionId, entryId);
    });
  }

  updateEntry(sessionId: string, entryId: string, patch: UpdateEntryInput): EntryRow {
    return transaction(this.#db, () => {
      const current = this.#requireEntry(sessionId, entryId);
      if (patch.payload === undefined && patch.extData === undefined) return current;
      const payload = encodeJson(patch.payload ?? current.payload, 'object');
      if (current.type === 'message' && patch.payload !== undefined) validateMessagePayload(JSON.parse(payload), current.role);
      const ext = encodeJson(patch.extData === undefined ? current.ext_data : { ...patch.extData,
        ...(current.ext_data.narrative === undefined ? {} : { narrative: current.ext_data.narrative }),
        ...(current.ext_data.output === undefined ? {} : { output: current.ext_data.output }) }, 'object');
      const now = Date.now();
      this.#db.prepare('UPDATE entries SET payload=?,ext_data=?,updated_at=? WHERE session_id=? AND id=?')
        .run(payload, ext, now, sessionId, entryId);
      this.#db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(now, sessionId);
      return this.#requireEntry(sessionId, entryId);
    });
  }

  #assertMetricsUnique(sessionId: string, metrics: EntryMetrics | null): void {
    if (metrics === null) return;
    const select = this.#db.prepare(
      "SELECT e.id FROM entries e, json_each(e.metrics_json,'$.requests') AS request " +
      "WHERE e.session_id=? AND json_extract(request.value,'$.requestId')=? LIMIT 1",
    );
    for (const request of metrics.requests) {
      if (select.get(sessionId, request.requestId)) throw new AppError('DUPLICATE_REQUEST_METRICS');
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
