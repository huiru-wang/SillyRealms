import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, type JsonObject, type JsonValue } from '../database/connection.js';
import { createServices, type Services } from '../services.js';
import type { SessionService } from '../sessions/service.js';
import { narrativePreset } from '../testing/fixtures.js';
import type { StateService } from './service.js';

let db: DatabaseSync, services: Services, sessions: SessionService, state: StateService, dataRoot: string;
beforeEach(() => {
  db = openDatabase(':memory:');
  dataRoot = mkdtempSync(join(tmpdir(), 'sr-state-service-'));
  services = createServices(db, dataRoot);
  services.models.create({ id: 'model', name: 'Model', provider_id: 'provider', model_id: 'model', credential_ref: 'credential-ref' });
  services.presets.create({ ...narrativePreset(), id: 'preset' });
  services.worlds.create({
    id: 'world', spec_version: '0.1', name: 'World', characters_json: [], openings_json: [],
    state_definition_json: { schema_version: 2 }, state: { day: 1 },
  });
  sessions = services.sessions;
  state = services.state;
  for (const id of ['one', 'two']) sessions.create({
    id, world_id: 'world', preset_id: 'preset', api_model_config_id: 'model', user_character_id: 'player', state: { reputation: 0 },
  });
});
afterEach(() => { vi.restoreAllMocks(); db.close(); rmSync(dataRoot, { recursive: true, force: true }); });

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
    expect(services.worlds.get('world')!.state_definition_json).toEqual({ schema_version: 2 });
    expect(state.getGlobal('missing')).toBeNull();
    expect(() => state.setGlobal('missing', {})).toThrow('WORLD_NOT_FOUND');
    expect(() => state.setSession('missing', {})).toThrow('SESSION_NOT_FOUND');
  });

  it('inherits message state through compaction and the linear predecessor chain', () => {
    append('root');
    state.setMessage('one', 'root', [{ key: 'coins', value: 3 }]);
    sessions.appendEntry('one', { id: 'summary', run_id: 'compact', type: 'compaction', role: null, payload: { summary: 'Summary' } });
    append('answer');
    expect(state.getMessage('one', 'answer')).toEqual([{ key: 'coins', value: 3 }]);
    state.setMessage('one', 'answer', [{ key: 'coins', value: 99 }]);
    append('continuation');
    expect(state.getMessage('one', 'summary')).toEqual([{ key: 'coins', value: 3 }]);
    expect(state.getMessage('one', 'continuation')).toEqual([{ key: 'coins', value: 99 }]);
    expect(sessions.getEntryState('one', 'continuation')).toBeNull();
    expect(sessions.getEntryState('one', 'answer')).toEqual([{ key: 'coins', value: 99 }]);
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
