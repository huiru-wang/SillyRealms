import type { JsonObject, JsonValue } from '../../infrastructure/database/connection.js';
import { isDeepStrictEqual } from 'node:util';
import { AppError } from '../../errors.js';
import type { SessionReader } from '../sessions/service.js';
import type { WorldReader } from '../worlds/service.js';
import { validateStateJson } from '@sillyrealms/sdk/state-validation';
import { evaluateWhen, type StateViews } from './when.js';
import { parseStatePath, prepareStatePatch } from './patch.js';
import { messageValues, replaceMessageValue } from './snapshot.js';
import { prepareInitialSnapshots } from './initial.js';
import { prepareMessageUpdates } from './message-updates.js';
import type { PreparedStatePatch, StateUpdate, StateEvent, PreparedMessageUpdates } from './types.js';

export type { StateViews } from './when.js';
export type {
  PreparedStatePatch, StateUpdate, StateWriteResult, StateEvent,
  AcceptedMessageUpdate, MessageUpdateResult, PreparedMessageUpdates,
} from './types.js';
export type { StateDefinition, StateDiagnostic, StateSchema, StateScope, StateValidationCode } from '@sillyrealms/sdk/state-validation';
export { StateValidationError } from '@sillyrealms/sdk/state-validation';

function identifier(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) throw new AppError('INVALID_STATE_OWNER');
  return value;
}

/** Read-only scope access, inheritance and field preparation; owners persist their columns. */
export class StateService {
  readonly #worlds: WorldReader;
  readonly #sessions: SessionReader;

  constructor({ worlds, sessions }: { worlds: WorldReader; sessions: SessionReader }) {
    this.#worlds = worlds;
    this.#sessions = sessions;
  }

  prepareInitialSnapshots(definition: JsonValue | null, overrides: unknown) {
    return prepareInitialSnapshots(definition, overrides);
  }

  getGlobal(worldId: string): JsonObject | null {
    return this.#worlds.getState(identifier(worldId));
  }

  requireGlobal(worldId: string): JsonObject {
    const snapshot = this.getGlobal(worldId);
    if (snapshot === null) throw new AppError('WORLD_NOT_FOUND');
    return snapshot;
  }

  getSession(sessionId: string): JsonObject | null {
    return this.#sessions.getState(identifier(sessionId));
  }

  requireSession(sessionId: string): JsonObject {
    const snapshot = this.getSession(sessionId);
    if (snapshot === null) throw new AppError('SESSION_NOT_FOUND');
    return snapshot;
  }

  /** An explicit empty snapshot overrides earlier state in the same session. */
  getMessage(sessionId: string, entryId: string): JsonValue[] | null {
    return this.#sessions.inheritedEntryState(identifier(sessionId), identifier(entryId)) ?? null;
  }

  requireMessage(sessionId: string, entryId: string): JsonValue[] | null {
    const state = this.#sessions.inheritedEntryState(identifier(sessionId), identifier(entryId));
    if (state === undefined) throw new AppError('ENTRY_NOT_FOUND');
    return state;
  }

  /** The live message scope belongs to the current tip, including inherited state. */
  getCurrentMessage(sessionId: string, path?: string): JsonObject {
    const session = this.#sessions.require(identifier(sessionId));
    const root = path === undefined ? undefined : parseStatePath(path, 'message')[0];
    const entries = session.tipEntryId === null ? null : this.requireMessage(sessionId, session.tipEntryId);
    return { ...messageValues(entries, root) };
  }

  /** Describe an effective change without publishing; empty path replaces the whole scope. */
  describeChange(scope: StateEvent['data']['scope'], before: JsonObject, after: JsonObject, path = ''): StateEvent | null {
    const read = (snapshot: JsonObject): JsonValue | undefined => {
      let value: JsonValue | undefined = snapshot;
      for (const key of path === '' ? [] : parseStatePath(path, scope)) {
        if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, key)) return undefined;
        value = value[key];
      }
      return value;
    };
    const previous = read(before), next = read(after);
    if (isDeepStrictEqual(previous, next)) return null;
    // A missing value cannot be represented as JSON; replacement also communicates deletion.
    return { event: 'state.changed', data: { scope, path: next === undefined ? '' : path, value: structuredClone(next === undefined ? after : next) } };
  }

  prepareGlobalPatch(worldId: string, update: StateUpdate): PreparedStatePatch<JsonObject> {
    const world = this.#worlds.require(identifier(worldId));
    return prepareStatePatch(world.state, world.stateDefinition, 'global', update);
  }

  prepareSessionPatch(sessionId: string, update: StateUpdate): PreparedStatePatch<JsonObject> {
    const session = this.#sessions.require(identifier(sessionId));
    const world = this.#worlds.require(session.worldId);
    return prepareStatePatch(session.state, world.stateDefinition, 'session', update);
  }

  prepareMessagePatch(sessionId: string, entryId: string, update: StateUpdate): PreparedStatePatch<JsonValue[] | null> {
    const session = this.#sessions.require(identifier(sessionId));
    const entry = this.#sessions.getEntry(session.id, identifier(entryId));
    if (!entry) throw new AppError('ENTRY_NOT_FOUND');
    const world = this.#worlds.require(session.worldId);
    const root = parseStatePath(update.path, 'message')[0]!;
    const inherited = this.getMessage(session.id, entry.id);
    const prepared = prepareStatePatch(messageValues(inherited, root), world.stateDefinition, 'message', update);
    // Ignored or equal writes must not materialize an inherited snapshot.
    if (!prepared.changed) return { snapshot: entry.state, changed: false };
    return { snapshot: replaceMessageValue(inherited!, root, prepared.snapshot[root]!), changed: true };
  }

  /** Model-only message updates are computed per row; callers own admission, transactions and events. */
  prepareMessageUpdates(input: {
    sessionId: string; parentId: string; allowedRoots: readonly string[]; updates: readonly unknown[];
  }): PreparedMessageUpdates {
    const session = this.#sessions.require(identifier(input.sessionId));
    const inherited = this.requireMessage(session.id, identifier(input.parentId));
    const world = this.#worlds.require(session.worldId);
    const prepared = prepareMessageUpdates(inherited, world.stateDefinition, input.allowedRoots, input.updates);
    const change = prepared.changed
      ? this.describeChange('message', messageValues(inherited), messageValues(prepared.snapshot))
      : null;
    return { ...prepared, change };
  }

  /** Read an independent view at the supplied predecessor; never initialize opening state. */
  getViews(input: { worldId: string; sessionId: string; entryId: string | null }): StateViews {
    const global = this.requireGlobal(input.worldId), session = this.requireSession(input.sessionId);
    const entries = input.entryId === null ? [] : this.requireMessage(input.sessionId, input.entryId) ?? [];
    try {
      validateStateJson(global); validateStateJson(session);
      const message = messageValues(entries);
      for (const value of Object.values(message)) validateStateJson(value);
      return structuredClone({ global, session, message });
    } catch { throw new AppError('INVALID_NARRATIVE_STATE'); }
  }

  /** A bounded, read-only condition over the caller's captured views. */
  evaluateWhen(expression: string, views: StateViews): boolean {
    try { return evaluateWhen(expression, views); }
    catch { throw new AppError('INVALID_NARRATIVE_STATE'); }
  }
}
