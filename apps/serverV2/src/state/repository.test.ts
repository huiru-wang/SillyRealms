import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, type JsonObject, type JsonValue } from '../database/connection.js';
import { SessionRepository } from '../sessions/repository.js';
import { StateRepository } from './repository.js';

let db: DatabaseSync, sessions: SessionRepository, state: StateRepository;
beforeEach(() => {
  db = openDatabase(':memory:');
  db.exec(
    "INSERT INTO api_model_configs VALUES('model','Model','provider','model','credential-ref',1,1);" +
    "INSERT INTO presets VALUES('preset','narrative','Narrative',NULL,'{}',1,1);" +
    "INSERT INTO worlds(id,spec_version,name,characters_json,openings_json,state_definition_json,state,created_at,updated_at) " +
    "VALUES('world','0.1','World','[]','[]','{\"schema_version\":2}','{\"day\":1}',1,1);",
  );
  sessions = new SessionRepository(db);
  state = new StateRepository(db);
  for (const id of ['one', 'two']) sessions.create({
    id, world_id: 'world', preset_id: 'preset', api_model_config_id: 'model', user_character_id: 'player', state: { reputation: 0 },
  });
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

function append(id: string, parent_id?: string, sessionId = 'one') {
  return sessions.appendEntry(sessionId, {
    id, parent_id, run_id: 'run', type: 'message', role: 'assistant',
    payload: { text: id }, ext_data: { custom: true },
  });
}

describe('scope snapshot persistence', () => {
  it('keeps global runtime state separate from definitions and session state', () => {
    state.setGlobal('world', { day: 2 });
    state.setSession('one', { reputation: 10 });
    expect(state.getGlobal('world')).toEqual({ day: 2 });
    expect(state.getSession('one')).toEqual({ reputation: 10 });
    expect(state.getSession('two')).toEqual({ reputation: 0 });
    expect(JSON.parse(String(db.prepare('SELECT state_definition_json FROM worlds WHERE id=?').get('world')!.state_definition_json)))
      .toEqual({ schema_version: 2 });
    expect(state.getGlobal('missing')).toBeNull();
    expect(() => state.setGlobal('missing', {})).toThrow('WORLD_NOT_FOUND');
    expect(() => state.setSession('missing', {})).toThrow('SESSION_NOT_FOUND');
  });

  it('inherits message state through compaction and follows parent links across branches', () => {
    append('root');
    state.setMessage('one', 'root', [{ key: 'coins', value: 3 }]);
    sessions.appendEntry('one', { id: 'summary', run_id: 'compact', type: 'compaction', role: null, payload: { summary: 'Summary' } });
    append('old-branch');
    state.setMessage('one', 'old-branch', [{ key: 'coins', value: 99 }]);
    sessions.setTip('one', 'summary');
    append('new-branch');
    expect(state.getMessage('one', 'summary')).toEqual([{ key: 'coins', value: 3 }]);
    expect(state.getMessage('one', 'new-branch')).toEqual([{ key: 'coins', value: 3 }]);
    expect(state.getMessage('one', 'old-branch')).toEqual([{ key: 'coins', value: 99 }]);
  });

  it('distinguishes an empty snapshot from inherited NULL and preserves ancestor snapshots', () => {
    append('root');
    expect(state.getMessage('one', 'root')).toBeNull();
    state.setMessage('one', 'root', [{ key: 'coins', value: 3 }]);
    append('child');
    state.setMessage('one', 'child', []);
    expect(state.getMessage('one', 'child')).toEqual([]);
    state.setMessage('one', 'child', null);
    expect(state.getMessage('one', 'child')).toEqual([{ key: 'coins', value: 3 }]);
    expect(sessions.getEntry('one', 'child')!.state).toBeNull();
    expect(sessions.getEntry('one', 'root')!.state).toEqual([{ key: 'coins', value: 3 }]);
  });

  it('updates only the selected state field and updated_at', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    const entry = append('root');
    sessions.setMetrics('one', entry.id, { requests: [{ requestId: 'request', modelId: 'actual', status: 'completed', usage: null }] });
    const before = sessions.getEntry('one', entry.id)!;
    vi.mocked(Date.now).mockReturnValue(200);
    state.setMessage('one', entry.id, [{ key: 'inventory', value: { coins: 7 } }]);
    expect(sessions.getEntry('one', entry.id)).toEqual({
      ...before, state: [{ key: 'inventory', value: { coins: 7 } }], updated_at: 200,
    });
    expect(sessions.get('one')!.updated_at).toBe(100);
    expect(() => state.setMessage('two', entry.id, [])).toThrow('ENTRY_NOT_FOUND');
    expect(state.getMessage('two', entry.id)).toBeNull();
  });

  it('rejects invalid JSON shapes and never reads another session through a corrupt chain', () => {
    append('root'); append('child');
    append('foreign', undefined, 'two');
    state.setMessage('two', 'foreign', [{ key: 'secret', value: 7 }]);
    expect(() => state.setGlobal('world', [] as unknown as JsonObject)).toThrow();
    expect(() => state.setSession('one', { value: NaN })).toThrow();
    expect(() => state.setMessage('one', 'child', {} as unknown as JsonValue[])).toThrow();
    expect(() => state.setMessage('one', 'child', [undefined] as unknown as JsonValue[])).toThrow();
    db.prepare('UPDATE entries SET parent_id=? WHERE id=?').run('foreign', 'child');
    expect(() => state.getMessage('one', 'child')).toThrow('INVALID_PARENT_CHAIN');
    db.prepare('UPDATE entries SET parent_id=? WHERE id=?').run('child', 'child');
    expect(() => state.getMessage('one', 'child')).toThrow('INVALID_PARENT_CHAIN');
  });
});
