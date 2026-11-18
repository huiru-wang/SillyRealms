import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { JsonObject, JsonValue } from '../database/connection.js';
import { AppError } from '../errors.js';
import type { ModelService } from '../models/service.js';
import type { PresetService } from '../presets/service.js';
import type { WorldService } from '../worlds/service.js';
import { SessionRepository } from './repository.js';
import {
  appendEntrySchema, createSessionSchema, entryListSchema, identifier, metricsSchema,
  sessionListSchema, updateEntrySchema, updateSessionSchema,
} from './schema.js';
import type {
  AppendEntryInput, CreateSessionInput, EntryListOptions, EntryMetrics, EntryRecord,
  SessionListOptions, SessionRecord, UpdateEntryInput, UpdateSessionInput,
} from './types.js';

export type {
  AppendEntryInput, CreateSessionInput, EntryListOptions, EntryMetrics, EntryRecord,
  SessionListOptions, SessionRecord, UpdateEntryInput, UpdateSessionInput,
} from './types.js';

type Dependencies = { worlds: WorldService; presets: PresetService; models: ModelService };

function validateEntry(entry: EntryRecord): EntryRecord {
  return entry.metrics_json === null ? entry : { ...entry, metrics_json: metricsSchema.parse(entry.metrics_json) };
}

/** Public session operations. Cross-module checks use services; persistence stays private. */
export class SessionService {
  readonly #repository: SessionRepository;
  readonly #dependencies: Dependencies;

  constructor(db: DatabaseSync, dependencies: Dependencies) {
    this.#repository = new SessionRepository(db);
    this.#dependencies = dependencies;
  }

  get(id: string): SessionRecord | null {
    return this.#repository.get(identifier.parse(id));
  }

  create(input: CreateSessionInput): SessionRecord {
    const value = createSessionSchema.parse(input);
    this.#dependencies.worlds.require(value.world_id);
    this.#dependencies.presets.require(value.preset_id);
    this.#dependencies.models.require(value.api_model_config_id);
    return this.#repository.create({ ...value, id: value.id ?? randomUUID() });
  }

  list(options: SessionListOptions = {}): SessionRecord[] {
    return this.#repository.list(sessionListSchema.parse(options));
  }

  update(id: string, input: UpdateSessionInput): SessionRecord {
    const patch = updateSessionSchema.parse(input);
    this.require(id);
    if (patch.preset_id !== undefined) this.#dependencies.presets.require(patch.preset_id);
    if (patch.api_model_config_id !== undefined) this.#dependencies.models.require(patch.api_model_config_id);
    return this.#repository.update(id, patch);
  }

  delete(id: string): boolean {
    return this.#repository.delete(identifier.parse(id));
  }

  getEntry(sessionId: string, entryId: string): EntryRecord | null {
    const entry = this.#repository.getEntry(identifier.parse(sessionId), identifier.parse(entryId));
    return entry ? validateEntry(entry) : null;
  }

  appendEntry(sessionId: string, input: AppendEntryInput): EntryRecord {
    const value = appendEntrySchema.parse(input), id = value.id ?? randomUUID();
    const session = this.require(sessionId);
    if (value.parent_id !== undefined && value.parent_id !== session.tip_entry_id) throw new AppError('TIP_CONFLICT');
    if (session.tip_entry_id !== null) this.#readAncestors(sessionId, session.tip_entry_id);
    this.#assertMetricsRole(value.role, value.metrics_json ?? null);
    return validateEntry(this.#repository.appendEntry(sessionId, { ...value, id }));
  }

  listEntries(sessionId: string, options: EntryListOptions = {}): EntryRecord[] {
    this.require(sessionId);
    return this.#repository.listEntries(sessionId, entryListSchema.parse(options)).map(validateEntry);
  }

  listRunEntries(sessionId: string, runId: string): EntryRecord[] {
    this.require(sessionId);
    return this.#repository.listRunEntries(sessionId, identifier.parse(runId)).map(validateEntry);
  }

  getHistory(sessionId: string): EntryRecord[] {
    const session = this.require(sessionId);
    return session.tip_entry_id === null ? [] : this.#readAncestors(sessionId, session.tip_entry_id);
  }

  updateEntry(sessionId: string, entryId: string, input: UpdateEntryInput): EntryRecord {
    identifier.parse(sessionId); identifier.parse(entryId);
    return validateEntry(this.#repository.updateEntry(sessionId, entryId, updateEntrySchema.parse(input)));
  }

  /** NULL means no record; usage:null means a real request without reported usage. */
  setMetrics(sessionId: string, entryId: string, value: EntryMetrics | null): EntryRecord {
    const metrics = value === null ? null : metricsSchema.parse(value);
    const current = this.#requireEntry(sessionId, entryId);
    this.#assertMetricsRole(current.role, metrics);
    return validateEntry(this.#repository.setMetrics(sessionId, entryId, metrics));
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

  require(id: string): SessionRecord {
    const session = this.get(id);
    if (!session) throw new AppError('SESSION_NOT_FOUND');
    return session;
  }

  #requireEntry(sessionId: string, entryId: string): EntryRecord {
    const entry = this.getEntry(sessionId, entryId);
    if (!entry) throw new AppError('ENTRY_NOT_FOUND');
    return entry;
  }

  #readAncestors(sessionId: string, tip: string): EntryRecord[] {
    const result: EntryRecord[] = [], visited = new Set<string>();
    let current: string | null = tip, nextSequence = Infinity;
    while (current !== null) {
      if (visited.has(current)) throw new AppError('INVALID_PARENT_CHAIN', 'cycle');
      visited.add(current);
      const entry = this.getEntry(sessionId, current);
      if (!entry || !Number.isSafeInteger(entry.seq) || entry.seq < 1 || entry.seq >= nextSequence) {
        throw new AppError('INVALID_PARENT_CHAIN');
      }
      result.push(entry); current = entry.parent_id; nextSequence = entry.seq;
    }
    return result.reverse();
  }

  #assertMetricsRole(role: EntryRecord['role'], metrics: EntryMetrics | null): void {
    if (metrics !== null && role === 'user') throw new AppError('USER_ENTRY_METRICS_NOT_ALLOWED');
  }
}
