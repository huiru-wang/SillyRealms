import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { JsonObject, JsonValue } from '../../infrastructure/database/connection.js';
import type { RuntimeCache, RunWritePermit } from '../../infrastructure/cache/index.js';
import { AppError } from '../../errors.js';
import type { ModelReader } from '../models/service.js';
import type { PresetReader } from '../presets/service.js';
import type { WorldReader } from '../worlds/service.js';
import { SessionRepository, type EntryRow, type SessionRow } from './repository.js';
import { narrativeOutputSchema, type NarrativeOutput } from './output.js';
import { createSessionSchema, identifier, sessionListSchema, updateSessionSchema, narrativeStopReasonSchema } from './schema.js';
import type { CreateSessionInput, RequestMetrics, SessionEntry, SessionListOptions, SessionPage, Session, UpdateSessionInput, NarrativeStopReason } from './types.js';
import { aggregateUsage, publicMessage, runOptionsSchema, type MessageInput, type RunOptions, type SummaryInput } from './run.js';

export type { CreateSessionInput, RequestMetrics, SessionEntry, SessionListOptions, SessionPage, Session, UpdateSessionInput, NarrativeStopReason } from './types.js';
export type { RunUsage, RunOptions, MessageInput, RunMessage, Capabilities } from './run.js';

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
    state: row.state, createdAt: row.created_at, updatedAt: row.updated_at,
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
    extData: row.ext_data, status: row.status,
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

  #assertSessionWrite(id: string, permit?: RunWritePermit): void {
    this.#dependencies.cache.assertSessionWrite(id, permit, this.get(id)?.worldId);
  }

  #assertRunWrite(sessionId: string, runId: string, permit: RunWritePermit): void {
    const { worldId } = this.require(sessionId);
    this.#dependencies.cache.assertSessionWrite(sessionId, permit, worldId);
    if (permit.runId !== runId || permit.worldId !== worldId) throw new AppError('SESSION_WRITE_LOCKED');
  }

  #assertStateWrite(id: string, permit?: RunWritePermit): void {
    this.#dependencies.cache.assertStateWrite(id, permit, this.get(id)?.worldId);
  }

  create(input: CreateSessionInput): Session {
    const value = createSessionSchema.parse(input);
    this.#dependencies.cache.assertWorldWrite(value.worldId);
    if (value.id !== undefined) this.#assertSessionWrite(value.id);
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
    this.#assertSessionWrite(identifier.parse(id));
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
    this.#assertSessionWrite(identifier.parse(id));
    return this.#repository.delete(identifier.parse(id));
  }

  getEntry(sessionId: string, entryId: string): SessionEntry | null {
    const entry = this.#repository.getEntry(identifier.parse(sessionId), identifier.parse(entryId));
    return entry ? toSessionEntry(entry) : null;
  }

  /** Reads only this message's result; missing/error output never inherits another message. */
  getMessageCharacterSprites(sessionId: string, entryId: string) {
    this.require(sessionId);
    const entry = this.#requireEntry(sessionId, entryId);
    if (entry.type !== 'message') throw new AppError('INVALID_REQUEST', '立绘结果只能查询消息条目');
    if (entry.role !== 'assistant') return null;
    return this.#repository.assistantCapabilities(sessionId, [entryId]).get(entryId)?.characterSprite ?? null;
  }

  createOpening(sessionId: string, runId: string, entry: MessageInput, output: NarrativeOutput) {
    this.#assertSessionWrite(sessionId);
    return publicMessage(toSessionEntry(this.#repository.createRun(sessionId, runId, entry.id, entry, 'assistant', narrativeOutputSchema.parse(output))));
  }

  beginRun(sessionId: string, runId: string, assistantId: string, user: MessageInput, permit: RunWritePermit) {
    this.#assertRunWrite(sessionId, runId, permit);
    return toSessionEntry(this.#repository.createRun(sessionId, runId, assistantId, user, 'user', {}));
  }

  appendSummary(sessionId: string, input: SummaryInput, permit?: RunWritePermit) {
    if (permit) this.#assertRunWrite(sessionId, input.runId, permit);
    else this.#assertSessionWrite(sessionId);
    return toSessionEntry(this.#repository.appendSummary(sessionId, input));
  }

  settleRun(sessionId: string, runId: string, assistantId: string, reason: NarrativeStopReason | null,
    reply: MessageInput | null, output: NarrativeOutput | null, metrics: RequestMetrics | null, permit: RunWritePermit) {
    this.#assertRunWrite(sessionId, runId, permit);
    return this.#repository.finishRun(sessionId, runId, assistantId, narrativeStopReasonSchema.nullable().parse(reason),
      reply, output ? narrativeOutputSchema.parse(output) : {}, metrics);
  }

  restartRun(sessionId: string, runId: string, previousId: string, assistantId: string, tip: string, permit: RunWritePermit) {
    this.#assertRunWrite(sessionId, runId, permit);
    const result = this.#repository.restartRun(sessionId, runId, previousId, assistantId, tip);
    const user = publicMessage(toSessionEntry(result.user));
    if (user.role !== 'user') throw new AppError('INVALID_REGENERATION_TARGET');
    return { userMessage: { id: user.id, role: user.role, content: user.content, timestamp: user.timestamp, status: 'complete' as const },
      deletedMessageIds: result.deletedMessageIds, tipEntryId: result.tipEntryId };
  }

  markStopping(sessionId: string, runId: string, assistantId: string) {
    this.#repository.markStopping(sessionId, runId, assistantId);
  }

  recoverInterruptedRuns() { this.#repository.recoverInterruptedRuns(); }

  getAssistantCapabilities(sessionId: string, ids: string[]) {
    return this.#repository.assistantCapabilities(sessionId, ids);
  }

  listRuns(sessionId: string, options: RunOptions = {}) {
    return this.#readRuns(identifier.parse(sessionId), runOptionsSchema.parse(options));
  }

  getRun(sessionId: string, id: string) {
    return this.#readRuns(sessionId, {}, identifier.parse(id)).items[0]!;
  }

  #readRuns(sessionId: string, options: RunOptions, id?: string) {
    const { selected, entries, ...page } = this.#repository.readRuns(sessionId, options, id);
    return { ...page, items: selected.map(run => ({
      id: run.id, status: run.status, stopReason: run.stopReason, assistantEntryId: run.assistantEntryId,
      createdAt: run.createdAt, finishedAt: run.finishedAt, capabilities: run.capabilities, usage: aggregateUsage([run.metrics]),
      messages: entries.filter(entry => entry.run_id === run.id).map(entry => publicMessage(toSessionEntry(entry))),
    })) };
  }

  recordedUsage(sessionId: string) {
    const session = this.require(sessionId);
    const usage = aggregateUsage(this.#repository.sessionMetrics(sessionId));
    let latestContext: {
      inputTokens: number | null; contextWindowTokens: number | null; modelId: string; stale: boolean;
      contextComposition?: { systemBytes: number; summaryBytes: number; historyBytes: number };
    } | null = null;
    const latest = this.#repository.latestMain(sessionId);
    if (latest) {
      const request = latest.metrics.requests.at(-1)!;
      const snapshot = latest.metrics.context?.requestId === request.requestId ? latest.metrics.context : undefined;
      const selected = this.#dependencies.models.get(session.runtimeConfig.apiModelConfigId);
      const tipSeq = session.tipEntryId === null ? 0 : this.#repository.getEntry(sessionId, session.tipEntryId)?.seq ?? 0;
      const stale = latest.seq > tipSeq || !selected || selected.modelId !== request.modelId ||
        selected.providerId !== request.provider ||
        (snapshot !== undefined && snapshot.apiModelConfigId !== session.runtimeConfig.apiModelConfigId);
      latestContext = {
        inputTokens: request.usage?.inputTokens ?? null,
        contextWindowTokens: snapshot?.contextWindowTokens ?? null,
        modelId: request.modelId, stale,
        ...(snapshot ? { contextComposition: snapshot.contextComposition } : {}),
      };
    }
    return { ...usage, latestContext };
  }

  getHistory(sessionId: string): SessionEntry[] {
    const session = this.require(sessionId);
    return session.tipEntryId === null ? [] : this.#repository.contextEntries(sessionId, session.tipEntryId).map(toSessionEntry);
  }

  getState(sessionId: string): JsonObject | null {
    return this.#repository.getState(identifier.parse(sessionId));
  }

  setState(sessionId: string, value: JsonObject): JsonObject {
    this.#assertStateWrite(identifier.parse(sessionId));
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
    this.#assertStateWrite(identifier.parse(sessionId));
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
}

export type SessionReader = Pick<SessionService, 'get' | 'require' | 'getState' | 'getEntry' | 'inheritedEntryState'>;
