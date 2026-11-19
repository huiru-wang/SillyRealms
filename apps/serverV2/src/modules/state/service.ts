import type { JsonObject, JsonValue } from '../../infrastructure/database/connection.js';
import { AppError } from '../../errors.js';
import type { SessionReader } from '../sessions/service.js';
import type { WorldReader } from '../worlds/service.js';
import { isSafeStateKey, validateStateJson } from '@sillyrealms/sdk/state-validation';
import { evaluateWhen, type StateViews } from './when.js';

export type { StateViews } from './when.js';

function identifier(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) throw new AppError('INVALID_STATE_OWNER');
  return value;
}

/** Read-only scope access and inheritance; owning modules persist their state columns. */
export class StateService {
  readonly #worlds: WorldReader;
  readonly #sessions: SessionReader;

  constructor({ worlds, sessions }: { worlds: WorldReader; sessions: SessionReader }) {
    this.#worlds = worlds;
    this.#sessions = sessions;
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

  /** NULL inherits along the linear predecessor chain; an explicit [] stops inheritance. */
  getMessage(sessionId: string, entryId: string): JsonValue[] | null {
    identifier(sessionId); identifier(entryId);
    const visited = new Set<string>();
    let current: string | null = entryId, nextSequence = Infinity;
    let result: JsonValue[] | null = null;
    while (current !== null) {
      if (visited.has(current)) throw new AppError('INVALID_PARENT_CHAIN', 'cycle');
      visited.add(current);
      const entry = this.#sessions.getEntry(sessionId, current);
      if (!entry) {
        if (current === entryId) return null;
        throw new AppError('INVALID_PARENT_CHAIN');
      }
      if (!Number.isSafeInteger(entry.seq) || entry.seq < 1 || entry.seq >= nextSequence) {
        throw new AppError('INVALID_PARENT_CHAIN');
      }
      if (result === null && entry.state !== null) result = entry.state;
      nextSequence = entry.seq;
      current = entry.parentId;
    }
    return result;
  }

  requireMessage(sessionId: string, entryId: string): JsonValue[] | null {
    if (!this.#sessions.getEntry(identifier(sessionId), identifier(entryId))) throw new AppError('ENTRY_NOT_FOUND');
    return this.getMessage(sessionId, entryId);
  }

  /** Read an independent view at the supplied predecessor; never initialize opening state. */
  getViews(input: { worldId: string; sessionId: string; entryId: string | null }): StateViews {
    const global = this.requireGlobal(input.worldId), session = this.requireSession(input.sessionId);
    const entries = input.entryId === null ? [] : this.requireMessage(input.sessionId, input.entryId) ?? [];
    const message: JsonObject = Object.create(null);
    try {
      validateStateJson(global); validateStateJson(session);
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.key !== 'string'
          || !isSafeStateKey(entry.key) || !Object.hasOwn(entry, 'value') || Object.hasOwn(message, entry.key)) {
          throw new AppError('INVALID_NARRATIVE_STATE');
        }
        validateStateJson(entry.value);
        message[entry.key] = entry.value;
      }
    } catch { throw new AppError('INVALID_NARRATIVE_STATE'); }
    return structuredClone({ global, session, message });
  }

  /** A bounded, read-only condition over the caller's captured views. */
  evaluateWhen(expression: string, views: StateViews): boolean {
    try { return evaluateWhen(expression, views); }
    catch { throw new AppError('INVALID_NARRATIVE_STATE'); }
  }
}
