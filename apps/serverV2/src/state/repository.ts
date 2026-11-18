import type { DatabaseSync } from 'node:sqlite';
import { encodeJson, transaction, type JsonObject, type JsonValue } from '../database/connection.js';

function identifier(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) throw new Error('INVALID_STATE_OWNER');
  return value;
}

/** Stores complete scope snapshots. Definition/rule evaluation belongs to the state service. */
export class StateRepository {
  constructor(private readonly db: DatabaseSync) {}

  getGlobal(worldId: string): JsonObject | null {
    const row = this.db.prepare('SELECT state FROM worlds WHERE id=?').get(identifier(worldId));
    return row ? JSON.parse(String(row.state)) as JsonObject : null;
  }

  setGlobal(worldId: string, value: JsonObject): JsonObject {
    const state = encodeJson(value, 'object');
    const result = this.db.prepare('UPDATE worlds SET state=?,updated_at=? WHERE id=?')
      .run(state, Date.now(), identifier(worldId));
    if (!result.changes) throw new Error('WORLD_NOT_FOUND');
    return JSON.parse(state) as JsonObject;
  }

  getSession(sessionId: string): JsonObject | null {
    const row = this.db.prepare('SELECT state FROM sessions WHERE id=?').get(identifier(sessionId));
    return row ? JSON.parse(String(row.state)) as JsonObject : null;
  }

  setSession(sessionId: string, value: JsonObject): JsonObject {
    const state = encodeJson(value, 'object');
    const result = this.db.prepare('UPDATE sessions SET state=?,updated_at=? WHERE id=?')
      .run(state, Date.now(), identifier(sessionId));
    if (!result.changes) throw new Error('SESSION_NOT_FOUND');
    return JSON.parse(state) as JsonObject;
  }

  /** NULL inherits along parent_id, including compaction entries; an explicit [] stops inheritance. */
  getMessage(sessionId: string, entryId: string): JsonValue[] | null {
    identifier(sessionId); identifier(entryId);
    return transaction(this.db, () => {
      const select = this.db.prepare('SELECT parent_id,seq,state FROM entries WHERE session_id=? AND id=?');
      const visited = new Set<string>();
      let current: string | null = entryId, nextSequence = Infinity;
      let result: JsonValue[] | null = null;
      while (current !== null) {
        if (visited.has(current)) throw new Error('INVALID_PARENT_CHAIN: cycle');
        visited.add(current);
        const row: Record<string, unknown> | undefined = select.get(sessionId, current);
        if (!row) {
          if (current === entryId) return null;
          throw new Error('INVALID_PARENT_CHAIN');
        }
        const sequence = Number(row.seq);
        if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence >= nextSequence) throw new Error('INVALID_PARENT_CHAIN');
        if (result === null && row.state !== null) result = JSON.parse(String(row.state)) as JsonValue[];
        nextSequence = sequence;
        current = row.parent_id === null ? null : String(row.parent_id);
      }
      return result;
    });
  }

  /** Writes only this entry's snapshot. NULL restores inheritance; it never clears an ancestor. */
  setMessage(sessionId: string, entryId: string, value: JsonValue[] | null): JsonValue[] | null {
    const state = value === null ? null : encodeJson(value, 'array');
    const result = this.db.prepare('UPDATE entries SET state=?,updated_at=? WHERE session_id=? AND id=?')
      .run(state, Date.now(), identifier(sessionId), identifier(entryId));
    if (!result.changes) throw new Error('ENTRY_NOT_FOUND');
    return state === null ? null : JSON.parse(state) as JsonValue[];
  }
}
