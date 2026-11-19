import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { JsonObject, JsonValue } from '../../infrastructure/database/connection.js';
import { AppError } from '../../errors.js';
import type { ModelReader } from '../models/service.js';
import type { PresetReader } from '../presets/service.js';
import type { WorldReader } from '../worlds/service.js';
import { SessionRepository, type EntryRow, type SessionRow } from './repository.js';
import {
  appendEntrySchema, createSessionSchema, entryListSchema, identifier, metricsSchema,
  sessionListSchema, updateEntrySchema, updateSessionSchema, narrativeOutcomeSchema, entryRunListSchema,
} from './schema.js';
import type {
  AppendEntryInput, CreateSessionInput, EntryListOptions, EntryMetrics, SessionEntry,
  SessionListOptions, SessionPage, Session, UpdateEntryInput, UpdateSessionInput,
  NarrativeOutcome, EntryRunListOptions, EntryRunPage,
} from './types.js';

export type {
  AppendEntryInput, CreateSessionInput, EntryListOptions, EntryMetrics, SessionEntry,
  SessionListOptions, SessionPage, Session, UpdateEntryInput, UpdateSessionInput,
  NarrativeOutcome, EntryRunListOptions, EntryRunPage,
  NarrativeStopReason, EntryRun,
} from './types.js';

type Dependencies = { worlds: WorldReader; presets: PresetReader; models: ModelReader };

function toSession(row: SessionRow): Session {
  return {
    id: row.id, worldId: row.world_id, presetId: row.preset_id, apiModelConfigId: row.api_model_config_id,
    userCharacterId: row.user_character_id, tipEntryId: row.tip_entry_id, title: row.title,
    state: row.state, usage: row.usage_json, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function toSessionEntry(row: EntryRow): SessionEntry {
  const kind = row.type === 'message'
    ? { type: 'message' as const, role: row.role }
    : { type: 'compaction' as const, role: null };
  return {
    ...kind,
    id: row.id, sessionId: row.session_id, parentId: row.parent_id, runId: row.run_id, seq: row.seq,
    timestamp: row.timestamp, payload: row.payload, state: row.state, extData: row.ext_data,
    metrics: row.metrics_json === null ? null : metricsSchema.parse(row.metrics_json),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/** Public session operations. Cross-module checks use services; persistence stays private. */
export class SessionService {
  readonly #repository: SessionRepository;
  readonly #dependencies: Dependencies;

  constructor(db: DatabaseSync, dependencies: Dependencies) {
    this.#repository = new SessionRepository(db);
    this.#dependencies = dependencies;
  }

  get(id: string): Session | null {
    const row = this.#repository.get(identifier.parse(id));
    return row ? toSession(row) : null;
  }

  create(input: CreateSessionInput): Session {
    const value = createSessionSchema.parse(input);
    const world = this.#dependencies.worlds.require(value.worldId);
    if (!world.characters.some(character => character && typeof character === 'object' && !Array.isArray(character)
      && character.id === value.userCharacterId && character.player_selectable === true)) {
      throw new AppError('INVALID_SESSION_CHARACTER');
    }
    this.#dependencies.presets.require(value.presetId);
    this.#dependencies.models.require(value.apiModelConfigId);
    return toSession(this.#repository.create({ ...value, id: value.id ?? randomUUID() }));
  }

  list(options: SessionListOptions = {}): Session[] {
    return this.#repository.list(sessionListSchema.parse(options)).map(toSession);
  }

  listPage(options: SessionListOptions = {}): SessionPage {
    const page = this.#repository.listPage(sessionListSchema.parse(options));
    return { items: page.items.map(toSession), hasMore: page.hasMore };
  }

  countByWorldIds(worldIds: readonly string[]): Record<string, number> {
    return this.#repository.countByWorldIds([...new Set(worldIds.map(id => identifier.parse(id)))]);
  }

  listIdsByWorld(worldId: string): string[] {
    return this.#repository.listIdsByWorld(identifier.parse(worldId));
  }

  update(id: string, input: UpdateSessionInput): Session {
    const patch = updateSessionSchema.parse(input);
    this.require(id);
    if (patch.presetId !== undefined) this.#dependencies.presets.require(patch.presetId);
    if (patch.apiModelConfigId !== undefined) this.#dependencies.models.require(patch.apiModelConfigId);
    return toSession(this.#repository.update(id, patch));
  }

  delete(id: string): boolean {
    return this.#repository.delete(identifier.parse(id));
  }

  getEntry(sessionId: string, entryId: string): SessionEntry | null {
    const entry = this.#repository.getEntry(identifier.parse(sessionId), identifier.parse(entryId));
    return entry ? toSessionEntry(entry) : null;
  }

  appendEntry(sessionId: string, input: AppendEntryInput): SessionEntry {
    const value = appendEntrySchema.parse(input), id = value.id ?? randomUUID();
    const session = this.require(sessionId);
    if (value.parentId !== undefined && value.parentId !== session.tipEntryId) throw new AppError('TIP_CONFLICT');
    if (session.tipEntryId !== null) this.#readAncestors(sessionId, session.tipEntryId);
    this.#assertMetricsRole(value.role, value.metrics ?? null);
    return toSessionEntry(this.#repository.appendEntry(sessionId, { ...value, id }));
  }

  listEntries(sessionId: string, options: EntryListOptions = {}): SessionEntry[] {
    this.require(sessionId);
    return this.#repository.listEntries(sessionId, entryListSchema.parse(options)).map(toSessionEntry);
  }

  listRunEntries(sessionId: string, runId: string): SessionEntry[] {
    this.require(sessionId);
    return this.#repository.listRunEntries(sessionId, identifier.parse(runId)).map(toSessionEntry);
  }

  listEntryRuns(sessionId: string, options: EntryRunListOptions = {}): EntryRunPage {
    this.require(sessionId);
    const page = this.#repository.listEntryRuns(sessionId, entryRunListSchema.parse(options));
    return { ...page, items: page.items.map(item => ({ ...item, entries: item.entries.map(toSessionEntry) })) };
  }

  recordedUsage(sessionId: string) {
    this.require(sessionId);
    const knownUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let recordedRequestCount = 0, unknownUsageRequestCount = 0;
    for (const metrics of this.#repository.listMetrics(sessionId)) for (const request of metrics.requests) {
      recordedRequestCount++;
      if (request.usage === null) { unknownUsageRequestCount++; continue; }
      for (const key of Object.keys(knownUsage) as Array<keyof typeof knownUsage>) knownUsage[key] += request.usage[key];
    }
    return { knownUsage, recordedRequestCount, unknownUsageRequestCount };
  }

  setNarrativeOutcome(sessionId: string, entryId: string, outcome: NarrativeOutcome): SessionEntry {
    identifier.parse(sessionId); identifier.parse(entryId);
    return toSessionEntry(this.#repository.setNarrativeOutcome(sessionId, entryId, narrativeOutcomeSchema.parse(outcome)));
  }

  getNarrativeOutcome(entry: SessionEntry): NarrativeOutcome | null {
    if (entry.type !== 'message') return null;
    const result = narrativeOutcomeSchema.safeParse(entry.extData.narrative);
    return result.success ? result.data : null;
  }

  getHistory(sessionId: string): SessionEntry[] {
    const session = this.require(sessionId);
    return session.tipEntryId === null ? [] : this.#readAncestors(sessionId, session.tipEntryId);
  }

  updateEntry(sessionId: string, entryId: string, input: UpdateEntryInput): SessionEntry {
    identifier.parse(sessionId); identifier.parse(entryId);
    return toSessionEntry(this.#repository.updateEntry(sessionId, entryId, updateEntrySchema.parse(input)));
  }

  /** NULL means no record; usage:null means a real request without reported usage. */
  setMetrics(sessionId: string, entryId: string, value: EntryMetrics | null): SessionEntry {
    const metrics = value === null ? null : metricsSchema.parse(value);
    const current = this.#requireEntry(sessionId, entryId);
    this.#assertMetricsRole(current.role, metrics);
    return toSessionEntry(this.#repository.setMetrics(sessionId, entryId, metrics));
  }

  getState(sessionId: string): JsonObject | null {
    return this.#repository.getState(identifier.parse(sessionId));
  }

  setState(sessionId: string, value: JsonObject): JsonObject {
    return this.#repository.setState(identifier.parse(sessionId), value);
  }

  /** Read only this entry's stored snapshot; inheritance belongs to StateService. */
  getEntryState(sessionId: string, entryId: string): JsonValue[] | null {
    return this.#repository.getEntryState(identifier.parse(sessionId), identifier.parse(entryId));
  }

  setEntryState(sessionId: string, entryId: string, value: JsonValue[] | null): JsonValue[] | null {
    return this.#repository.setEntryState(identifier.parse(sessionId), identifier.parse(entryId), value);
  }

  require(id: string): Session {
    const session = this.get(id);
    if (!session) throw new AppError('SESSION_NOT_FOUND');
    return session;
  }

  #requireEntry(sessionId: string, entryId: string): SessionEntry {
    const entry = this.getEntry(sessionId, entryId);
    if (!entry) throw new AppError('ENTRY_NOT_FOUND');
    return entry;
  }

  #readAncestors(sessionId: string, tip: string): SessionEntry[] {
    const result: SessionEntry[] = [], visited = new Set<string>();
    let current: string | null = tip, nextSequence = Infinity;
    while (current !== null) {
      if (visited.has(current)) throw new AppError('INVALID_PARENT_CHAIN', 'cycle');
      visited.add(current);
      const entry = this.getEntry(sessionId, current);
      if (!entry || !Number.isSafeInteger(entry.seq) || entry.seq < 1 || entry.seq >= nextSequence) {
        throw new AppError('INVALID_PARENT_CHAIN');
      }
      result.push(entry); current = entry.parentId; nextSequence = entry.seq;
    }
    return result.reverse();
  }

  #assertMetricsRole(role: SessionEntry['role'], metrics: EntryMetrics | null): void {
    if (metrics !== null && role === 'user') throw new AppError('USER_ENTRY_METRICS_NOT_ALLOWED');
  }
}

export type SessionReader = Pick<SessionService, 'get' | 'require' | 'getState' | 'getEntry'>;
