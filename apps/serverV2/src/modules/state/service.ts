import type { JsonObject, JsonValue } from '../../database/connection.js';
import { AppError } from '../../errors.js';
import type { SessionReader } from '../sessions/service.js';
import type { WorldReader } from '../worlds/service.js';

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
}
