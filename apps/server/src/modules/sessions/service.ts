import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { JsonObject, JsonValue } from '../../infrastructure/database/connection.js';
import type { RuntimeCache, RunWritePermit } from '../../infrastructure/cache/index.js';
import { AppError } from '../../errors.js';
import type { ModelReader } from '../models/service.js';
import type { PresetReader } from '../presets/service.js';
import type { WorldReader } from '../worlds/service.js';
import { SessionRepository, type EntryRow, type SessionRow } from './repository.js';
import { narrativeOutputSchema, readCharacterSpriteOutput, type CharacterSpriteOutput, type NarrativeOutput } from './output.js';
import { readStoredNarrativeOutput } from './stored-output.js';
import {
  appendEntrySchema, createSessionSchema, identifier, metricsSchema,
  sessionListSchema, updateEntrySchema, updateSessionSchema, narrativeOutcomeSchema, entryRunListSchema,
} from './schema.js';
import type {
  AppendEntryInput, CreateSessionInput, EntryMetrics, SessionEntry,
  SessionListOptions, SessionPage, Session, UpdateEntryInput, UpdateSessionInput,
  NarrativeOutcome, EntryRunListOptions, EntryRunPage, DeletedEntry,
} from './types.js';

export type {
  AppendEntryInput, CreateSessionInput, EntryMetrics, SessionEntry,
  SessionListOptions, SessionPage, Session, UpdateEntryInput, UpdateSessionInput,
  NarrativeOutcome, EntryRunListOptions, EntryRunPage, DeletedEntry,
  NarrativeStopReason, EntryRun,
} from './types.js';

export { createSessionSchema } from './schema.js';

export type {
  NarrativeOutput, StateUpdateOutput, ActionSuggestionsOutput,
  StateUpdateStatus, StateUpdateItem, ActionSuggestionsStatus,
  CharacterSpritePosition, CharacterSpriteItem, CharacterSpriteOutput, CharacterSpriteStatus,
} from './output.js';
export { parseCharacterSpriteItem, readCharacterSpriteOutput } from './output.js';

type Dependencies = { worlds: WorldReader; presets: PresetReader; models: ModelReader; cache: RuntimeCache };

function toSession(row: SessionRow): Session {
  return {
    id: row.id, worldId: row.world_id, runtimeConfig: row.runtime_config,
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
    timestamp: row.timestamp, payload: row.payload, state: row.state,
    extData: row.ext_data.output === undefined ? row.ext_data : { ...row.ext_data, output: readStoredNarrativeOutput(row.ext_data.output) },
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
    if (value.id !== undefined) this.#dependencies.cache.assertSessionWrite(value.id);
    const world = this.#dependencies.worlds.require(value.worldId);
    if (!world.characters.some(character => character && typeof character === 'object' && !Array.isArray(character)
      && character.id === value.userCharacterId && character.player_selectable === true)) {
      throw new AppError('INVALID_SESSION_CHARACTER');
    }
    this.#validateConfigReferences(value.runtimeConfig);
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

  listUsingPreset(presetId: string, type: 'narrative' | 'reply_assist' = 'narrative') {
    return this.#repository.listUsingPreset(presetId, type);
  }

  listIdsByWorld(worldId: string): string[] {
    return this.#repository.listIdsByWorld(identifier.parse(worldId));
  }

  update(id: string, input: UpdateSessionInput): Session {
    this.#dependencies.cache.assertSessionWrite(identifier.parse(id));
    const patch = updateSessionSchema.parse(input);
    this.require(id);
    if (patch.runtimeConfig) this.#validateConfigReferences(patch.runtimeConfig);
    return toSession(this.#repository.update(id, patch));
  }

  #validateConfigReferences(config: Partial<Session['runtimeConfig']>) {
    if (config.narrativePresetId) this.#dependencies.presets.require(config.narrativePresetId, 'narrative');
    if (config.apiModelConfigId) this.#dependencies.models.require(config.apiModelConfigId);
    if (config.replyAssistPresetId) this.#dependencies.presets.require(config.replyAssistPresetId, 'reply_assist');
  }

  delete(id: string): boolean {
    this.#dependencies.cache.assertSessionWrite(identifier.parse(id));
    return this.#repository.delete(identifier.parse(id));
  }

  getEntry(sessionId: string, entryId: string): SessionEntry | null {
    const entry = this.#repository.getEntry(identifier.parse(sessionId), identifier.parse(entryId));
    return entry ? toSessionEntry(entry) : null;
  }

  /** Reads only this message's result; missing/error output never inherits another message. */
  getMessageCharacterSprites(sessionId: string, entryId: string): CharacterSpriteOutput | null {
    this.require(sessionId);
    const entry = this.#requireEntry(sessionId, entryId);
    if (entry.type !== 'message') throw new AppError('INVALID_REQUEST', '立绘结果只能查询消息条目');
    if (entry.role !== 'assistant') return null;
    const output = entry.extData.output;
    if (output === null || typeof output !== 'object' || Array.isArray(output)) return null;
    return readCharacterSpriteOutput(output.characterSprite);
  }

  appendEntry(sessionId: string, input: AppendEntryInput, permit?: RunWritePermit): SessionEntry {
    this.#dependencies.cache.assertSessionWrite(identifier.parse(sessionId), permit);
    return this.#appendEntry(sessionId, appendEntrySchema.parse(input));
  }

  /** Stores trusted opening or generated assistant output alongside the entry. */
  appendNarrativeAssistant(sessionId: string, input: AppendEntryInput, output: NarrativeOutput, permit?: RunWritePermit): SessionEntry {
    this.#dependencies.cache.assertSessionWrite(identifier.parse(sessionId), permit);
    const value = appendEntrySchema.parse(input);
    if (value.type !== 'message' || value.role !== 'assistant') {
      throw new AppError('INVALID_REQUEST', '后处理结果只能保存在叙事助手消息');
    }
    const result = narrativeOutputSchema.parse(output);
    return this.#appendEntry(sessionId, { ...value, extData: { ...value.extData, output: result } });
  }

  #appendEntry(sessionId: string, value: AppendEntryInput): SessionEntry {
    const id = value.id ?? randomUUID();
    this.#assertMetricsRole(value.role, value.metrics ?? null);
    return toSessionEntry(this.#repository.appendEntry(sessionId, { ...value, id }));
  }

  listEntryRuns(sessionId: string, options: EntryRunListOptions = {}): EntryRunPage {
    this.require(sessionId);
    const page = this.#repository.listEntryRuns(sessionId, entryRunListSchema.parse(options));
    return { ...page, items: page.items.map(item => ({ ...item, entries: item.entries.map(toSessionEntry) })) };
  }

  recordedUsage(sessionId: string) {
    const session = this.require(sessionId);
    const knownUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let recordedRequestCount = 0, unknownUsageRequestCount = 0;
    for (const metrics of this.#repository.listMetrics(sessionId)) for (const request of metrics.requests) {
      recordedRequestCount++;
      if (request.usage === null) { unknownUsageRequestCount++; continue; }
      for (const key of Object.keys(knownUsage) as Array<keyof typeof knownUsage>) knownUsage[key] += request.usage[key];
    }
    let latestContext: {
      inputTokens: number | null; contextWindowTokens: number | null; modelId: string; stale: boolean;
      contextComposition?: { systemBytes: number; summaryBytes: number; historyBytes: number };
    } | null = null;
    const latest = this.#repository.latestNarrativeMetrics(sessionId);
    if (latest) {
      const request = latest.metrics.requests.at(-1)!;
      const snapshot = latest.metrics.context?.requestId === request.requestId ? latest.metrics.context : undefined;
      const selected = this.#dependencies.models.get(session.runtimeConfig.apiModelConfigId);
      const tipSeq = session.tipEntryId === null ? 0 : this.#repository.getEntry(sessionId, session.tipEntryId)?.seq ?? 0;
      const stale = latest.seq > tipSeq || !selected || selected.modelId !== request.modelId ||
        (request.provider !== null && selected.providerId !== request.provider) ||
        (snapshot !== undefined && snapshot.apiModelConfigId !== session.runtimeConfig.apiModelConfigId);
      latestContext = {
        inputTokens: request.usage?.inputTokens ?? null,
        contextWindowTokens: snapshot?.contextWindowTokens ?? null,
        modelId: request.modelId, stale,
        ...(snapshot ? { contextComposition: snapshot.contextComposition } : {}),
      };
    }
    return { knownUsage, recordedRequestCount, unknownUsageRequestCount, latestContext };
  }

  deleteEntry(sessionId: string, entryId: string, expectedTipEntryId: string | null, permit?: RunWritePermit): DeletedEntry {
    this.#dependencies.cache.assertSessionWrite(identifier.parse(sessionId), permit);
    identifier.parse(entryId);
    if (expectedTipEntryId !== null) identifier.parse(expectedTipEntryId);
    const deleted = this.#repository.deleteEntry(sessionId, entryId, expectedTipEntryId);
    return { ...deleted, entry: toSessionEntry(deleted.entry) };
  }

  setNarrativeOutcome(sessionId: string, entryId: string, outcome: NarrativeOutcome | null, permit?: RunWritePermit): SessionEntry {
    identifier.parse(sessionId); identifier.parse(entryId);
    this.#dependencies.cache.assertSessionWrite(sessionId, permit);
    return toSessionEntry(this.#repository.setNarrativeOutcome(sessionId, entryId, outcome === null ? null : narrativeOutcomeSchema.parse(outcome)));
  }

  getNarrativeOutcome(entry: SessionEntry): NarrativeOutcome | null {
    if (entry.type !== 'message') return null;
    const result = narrativeOutcomeSchema.safeParse(entry.extData.narrative);
    return result.success ? result.data : null;
  }

  getHistory(sessionId: string): SessionEntry[] {
    const session = this.require(sessionId);
    return session.tipEntryId === null ? [] : this.#repository.contextEntries(sessionId, session.tipEntryId).map(toSessionEntry);
  }

  updateEntry(sessionId: string, entryId: string, input: UpdateEntryInput): SessionEntry {
    identifier.parse(sessionId); identifier.parse(entryId);
    this.#dependencies.cache.assertSessionWrite(sessionId);
    const patch = updateEntrySchema.parse(input);
    if (this.#requireEntry(sessionId, entryId).type === 'compaction' && (patch.payload !== undefined || patch.extData !== undefined)) {
      throw new AppError('INVALID_REQUEST', '摘要内容及覆盖范围仅允许由服务内部维护');
    }
    return toSessionEntry(this.#repository.updateEntry(sessionId, entryId, patch));
  }

  /** NULL means no record; usage:null means a real request without reported usage. */
  setMetrics(sessionId: string, entryId: string, value: EntryMetrics | null): SessionEntry {
    this.#dependencies.cache.assertSessionWrite(identifier.parse(sessionId));
    const metrics = value === null ? null : metricsSchema.parse(value);
    const current = this.#requireEntry(sessionId, entryId);
    this.#assertMetricsRole(current.role, metrics);
    return toSessionEntry(this.#repository.setMetrics(sessionId, entryId, metrics));
  }

  getState(sessionId: string): JsonObject | null {
    return this.#repository.getState(identifier.parse(sessionId));
  }

  setState(sessionId: string, value: JsonObject): JsonObject {
    this.#dependencies.cache.assertStateWrite(identifier.parse(sessionId));
    return this.#repository.setState(identifier.parse(sessionId), value);
  }

  /** Read only this entry's stored snapshot; inheritance belongs to StateService. */
  inheritedEntryState(sessionId: string, entryId: string) {
    return this.#repository.inheritedEntryState(identifier.parse(sessionId), identifier.parse(entryId));
  }

  getEntryState(sessionId: string, entryId: string): JsonValue[] | null {
    return this.#repository.getEntryState(identifier.parse(sessionId), identifier.parse(entryId));
  }

  setEntryState(sessionId: string, entryId: string, value: JsonValue[] | null): JsonValue[] | null {
    this.#dependencies.cache.assertStateWrite(identifier.parse(sessionId));
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

  #assertMetricsRole(role: SessionEntry['role'], metrics: EntryMetrics | null): void {
    if (metrics !== null && role === 'user') throw new AppError('USER_ENTRY_METRICS_NOT_ALLOWED');
  }
}

export type SessionReader = Pick<SessionService, 'get' | 'require' | 'getState' | 'getEntry' | 'inheritedEntryState'>;
