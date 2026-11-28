import { transaction } from '../../infrastructure/database/transaction.js';
import type { DatabaseSync } from 'node:sqlite';
import { identifier, metricsSchema, runtimeConfigSchema, validateMessagePayload } from './schema.js';
import { AppError } from '../../errors.js';
import { encodeJson, type JsonObject, type JsonValue } from '../../infrastructure/database/connection.js';
import type { CreateSessionInput, SessionRuntimeConfig, RequestMetrics, SessionListOptions, UpdateSessionInput, NarrativeStopReason } from './types.js';
import { aggregateUsage, decodeCapabilities, decodeMetrics, decodeRun, type MessageInput, type RunOptions, type SummaryInput, type Capabilities } from './run.js';

export type SessionRow = {
  id: string; world_id: string; runtime_config: SessionRuntimeConfig;
  user_character_id: string; tip_entry_id: string | null; title: string | null;
  state: JsonObject; created_at: number; updated_at: number;
};
export type EntryRow = {
  id: string; session_id: string; parent_id: string | null; run_id: string; seq: number;
  timestamp: number; payload: JsonObject; state: JsonValue[] | null; ext_data: JsonObject;
  status: 'complete' | 'partial' | null; created_at: number; updated_at: number;
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
    status: row.status as EntryRow['status'],
    created_at: Number(row.created_at), updated_at: Number(row.updated_at),
  };
}

/** Module-private persistence for sessions, runs and entries. */
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
    return transaction(this.#db, () => {
      this.#db.prepare('DELETE FROM runs WHERE session_id=?').run(id);
      return this.#db.prepare('DELETE FROM sessions WHERE id=?').run(id).changes > 0;
    });
  }

  getEntry(sessionId: string, entryId: string): EntryRow | null {
    const row = this.#db.prepare('SELECT * FROM entries WHERE session_id=? AND id=?').get(sessionId, entryId);
    return row ? decodeEntry(row) : null;
  }

  /** Check the expected predecessor and advance the tip with the insertion in one transaction. */
  #appendEntry(sessionId: string, value: MessageInput & { runId: string; extData?: JsonObject; status: EntryRow['status'] } &
    ({ type: 'message'; role: 'user' | 'assistant' } | { type: 'compaction'; role: null })): EntryRow {
    identifier.parse(value.id);
    const payload = encodeJson(value.payload, 'object'), ext = encodeJson(value.type === 'compaction' ? value.extData ?? {} : {}, 'object');
    if (value.type === 'message' && validateMessagePayload(JSON.parse(payload), value.role).timestamp !== value.timestamp) {
      throw new AppError('INVALID_REQUEST', '消息时间与条目时间不一致');
    }
    const state = value.state == null ? null : encodeJson(value.state, 'array');
    return transaction(this.#db, () => {
      const session = this.#requireSession(sessionId);
      const parent = value.parentId;
      if (parent !== session.tip_entry_id) throw new AppError('TIP_CONFLICT');
      const latest = this.#db.prepare('SELECT id,seq FROM entries WHERE session_id=? ORDER BY seq DESC LIMIT 1').get(sessionId);
      if (parent !== (latest?.id ?? null)) throw new AppError('INVALID_PARENT_CHAIN');
      if (value.role !== 'assistant' && this.#db.prepare('SELECT 1 FROM runs WHERE assistant_entry_id=?').get(value.id)) {
        throw new AppError('INVALID_REQUEST');
      }
      const seq = Number(latest?.seq ?? 0) + 1;
      const now = Date.now();
      this.#db.prepare(
        'INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,timestamp,payload,state,ext_data,status,created_at,updated_at) ' +
        'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(value.id, sessionId, parent, value.runId, seq, value.type, value.role, value.timestamp,
        payload, state, ext, value.status, now, now);
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

  createRun(sessionId: string, runId: string, assistantId: string, entry: MessageInput,
    role: 'user' | 'assistant', capabilities: Capabilities) {
    return transaction(this.#db, () => {
      identifier.parse(runId);
      identifier.parse(assistantId);
      const opening = role === 'assistant';
      if (opening && (entry.parentId !== null || assistantId !== entry.id)) throw new AppError('INVALID_REQUEST');
      if (!opening && (assistantId === entry.id || this.#db.prepare('SELECT 1 FROM entries WHERE id=?').get(assistantId))) {
        throw new AppError('INVALID_REQUEST');
      }
      if (this.#activeId(sessionId)) throw new AppError('RUN_ALREADY_ACTIVE');
      this.#db.prepare('INSERT INTO runs(id,session_id,assistant_entry_id,status,created_at,finished_at,capabilities_json) VALUES(?,?,?,?,?,?,?)')
        .run(runId, sessionId, assistantId, opening ? 'completed' : 'running', entry.timestamp,
          opening ? entry.timestamp : null, encodeJson(capabilities, 'object'));
      return this.#appendEntry(sessionId, { ...entry, runId, type: 'message', role, status: 'complete' });
    });
  }

  #validateMetrics(sessionId: string, runId: string, incoming: RequestMetrics) {
    const result = metricsSchema.safeParse(incoming);
    if (!result.success) throw new AppError('INVALID_REQUEST_METRICS');
    const ids = result.data.requests.map(request => request.requestId);
    if (ids.length && this.#db.prepare(
      "SELECT 1 FROM runs r, json_tree(r.metrics_json) fact WHERE r.session_id=? AND r.id<>? " +
      "AND fact.key='requestId' AND fact.value IN (SELECT value FROM json_each(?)) LIMIT 1",
    ).get(sessionId, runId, JSON.stringify(ids))) throw new AppError('DUPLICATE_REQUEST_METRICS');
    return result.data;
  }

  appendSummary(sessionId: string, input: SummaryInput) {
    return transaction(this.#db, () => {
      const parent = this.#requireEntry(sessionId, input.parentId);
      if (parent.run_id !== input.runId) throw new AppError('TIP_CONFLICT');
      const run = this.requireRun(sessionId, input.runId);
      const covered = this.getEntry(sessionId, input.coveredThroughEntryId);
      if (!input.text.trim() || !/^[a-f0-9]{64}$/.test(input.sourceHash) || covered?.type !== 'message') {
        throw new AppError('INVALID_REQUEST');
      }
      const entry = this.#appendEntry(sessionId, {
        id: input.id, runId: input.runId, parentId: input.parentId, timestamp: Date.now(), type: 'compaction', role: null,
        status: null, payload: { summary: input.text },
        extData: { summary: { coveredThroughEntryId: input.coveredThroughEntryId, sourceHash: input.sourceHash } },
      });
      if (input.metrics) {
        run.metrics.summaries[input.id] = this.#validateMetrics(sessionId, input.runId, input.metrics);
        aggregateUsage([run.metrics]);
        this.#db.prepare('UPDATE runs SET metrics_json=? WHERE session_id=? AND id=?').run(encodeJson(run.metrics), sessionId, input.runId);
      }
      return entry;
    });
  }

  finishRun(sessionId: string, runId: string, assistantId: string, reason: NarrativeStopReason | null,
    reply: MessageInput | null, capabilities: Capabilities, main: RequestMetrics | null) {
    return transaction(this.#db, () => {
      const run = this.requireRun(sessionId, runId);
      if (run.assistantEntryId !== assistantId || (run.status !== 'running' && run.status !== 'stopping')) throw new AppError('RUN_NOT_FOUND');
      if (!reason && !reply) throw new AppError('MESSAGE_PERSIST_FAILED');
      if (reason && Object.keys(capabilities).length) throw new AppError('INVALID_REQUEST');
      if (reply) {
        if (reply.id !== assistantId) throw new AppError('INVALID_REQUEST');
        this.#appendEntry(sessionId, { ...reply, type: 'message', role: 'assistant', status: reason ? 'partial' : 'complete', runId });
      }
      run.metrics.main = main === null ? null : this.#validateMetrics(sessionId, runId, main);
      const usage = aggregateUsage([run.metrics]);
      const result = this.#db.prepare("UPDATE runs SET status=?, stop_reason=?, capabilities_json=?, metrics_json=?, finished_at=? " +
        "WHERE session_id=? AND id=? AND assistant_entry_id=? AND status IN ('running','stopping')")
        .run(reason ? 'stopped' : 'completed', reason, encodeJson(capabilities), encodeJson(run.metrics), Date.now(), sessionId, runId, assistantId);
      if (result.changes !== 1) throw new AppError('RUN_NOT_FOUND');
      return { stopReason: reason, usage, tipEntryId: this.#requireSession(sessionId).tip_entry_id,
        savedMessageIds: this.#db.prepare("SELECT id FROM entries WHERE session_id=? AND run_id=? AND type='message' ORDER BY seq")
          .all(sessionId, runId).map(row => String(row.id)) };
    });
  }

  restartRun(sessionId: string, runId: string, expectedId: string, assistantId: string, tip: string) {
    return transaction(this.#db, () => {
      const session = this.#requireSession(sessionId);
      if (session.tip_entry_id !== tip) throw new AppError('TIP_CONFLICT');
      const run = this.requireRun(sessionId, runId);
      if (this.#requireEntry(sessionId, tip).run_id !== runId || run.assistantEntryId !== expectedId ||
        (run.status !== 'completed' && run.status !== 'stopped')) throw new AppError('INVALID_REGENERATION_TARGET');
      const user = this.#db.prepare("SELECT * FROM entries WHERE session_id=? AND run_id=? AND role='user'").get(sessionId, runId);
      if (!user || expectedId === assistantId || this.#db.prepare('SELECT 1 FROM entries WHERE id=?').get(assistantId)) throw new AppError('INVALID_REGENERATION_TARGET');
      const deleted = this.getEntry(sessionId, expectedId);
      if (deleted && (deleted.run_id !== runId || deleted.role !== 'assistant')) throw new AppError('INVALID_REGENERATION_TARGET');
      const tipEntryId = deleted ? this.#deleteEntry(sessionId, expectedId, tip).tipEntryId : tip;
      this.#db.prepare("UPDATE runs SET assistant_entry_id=?, status='running', stop_reason=NULL, finished_at=NULL, capabilities_json='{}', " +
        "metrics_json=json_set(metrics_json,'$.main',null) WHERE session_id=? AND id=?").run(assistantId, sessionId, runId);
      return { user: decodeEntry(user), tipEntryId, deletedMessageIds: deleted ? [expectedId] : [] };
    });
  }

  markStopping(sessionId: string, runId: string, assistantId: string) {
    if (!this.#db.prepare("UPDATE runs SET status='stopping' WHERE session_id=? AND id=? AND assistant_entry_id=? AND status IN ('running','stopping')")
      .run(sessionId, runId, assistantId).changes) throw new AppError('RUN_NOT_FOUND');
  }

  recoverInterruptedRuns() {
    this.#db.prepare("UPDATE runs SET stop_reason=CASE status WHEN 'stopping' THEN 'cancelled' ELSE 'server_shutdown' END, " +
      "status='stopped',finished_at=? WHERE status IN ('running','stopping')").run(Date.now());
  }

  requireRun(sessionId: string, runId: string) {
    const row = this.#db.prepare('SELECT * FROM runs WHERE session_id=? AND id=?').get(sessionId, runId);
    if (!row) throw new AppError('RUN_NOT_FOUND');
    return decodeRun(row);
  }

  #activeId(sessionId: string) {
    const row = this.#db.prepare("SELECT id FROM runs WHERE session_id=? AND status IN ('running','stopping')").get(sessionId);
    return row ? String(row.id) : null;
  }

  readRuns(sessionId: string, options: RunOptions, id?: string) {
    return transaction(this.#db, () => {
      const session = this.#requireSession(sessionId), limit = options.limit ?? 5;
      const rows = id === undefined
        ? this.#db.prepare('SELECT * FROM runs WHERE session_id=? AND page_key<? ORDER BY page_key DESC LIMIT ?')
          .all(sessionId, options.beforePageKey ?? Number.MAX_SAFE_INTEGER, limit + 1).map(decodeRun)
        : [this.requireRun(sessionId, id)];
      const selected = rows.slice(0, limit);
      const entries = selected.length ? this.#db.prepare("SELECT * FROM entries WHERE session_id=? AND type='message' AND run_id IN (" +
        selected.map(() => '?').join(',') + ') ORDER BY run_id,seq').all(sessionId, ...selected.map(run => run.id)).map(decodeEntry) : [];
      return { selected, entries, tipEntryId: session.tip_entry_id, activeRunId: this.#activeId(sessionId),
        hasMore: rows.length > limit, nextPageKey: rows.length > limit ? selected.at(-1)!.pageKey : null };
    });
  }

  assistantCapabilities(sessionId: string, ids: string[]) {
    if (!ids.length) return new Map<string, Capabilities>();
    const rows = this.#db.prepare('SELECT assistant_entry_id,capabilities_json FROM runs WHERE session_id=? AND assistant_entry_id IN (' +
      ids.map(() => '?').join(',') + ')').all(sessionId, ...ids);
    if (rows.length !== new Set(ids).size) throw new AppError('INTERNAL_ERROR', 'Missing owning run for saved assistant');
    return new Map(rows.map(row => [String(row.assistant_entry_id), decodeCapabilities(row.capabilities_json)]));
  }

  sessionMetrics(sessionId: string) {
    return this.#db.prepare('SELECT metrics_json FROM runs WHERE session_id=?').all(sessionId)
      .map(row => decodeMetrics(row.metrics_json));
  }

  latestMain(sessionId: string) {
    const row = this.#db.prepare("SELECT e.seq,r.metrics_json FROM runs r JOIN entries e ON e.session_id=r.session_id AND e.run_id=r.id AND e.id=r.assistant_entry_id AND e.role='assistant' " +
      "WHERE r.session_id=? AND json_array_length(r.metrics_json,'$.main.requests')>0 ORDER BY e.seq DESC LIMIT 1").get(sessionId);
    return row ? { seq: Number(row.seq), metrics: decodeMetrics(row.metrics_json).main! } : null;
  }

  #deleteEntry(sessionId: string, entryId: string, expectedTipEntryId: string | null) {
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
