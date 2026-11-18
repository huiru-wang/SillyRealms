import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../database/connection.js';
import { createServices, type Services } from '../../services.js';
import type { SessionService } from '../sessions/service.js';
import { narrativePreset } from '../../testing/fixtures.js';
import type { StateService } from './service.js';

let db: DatabaseSync, services: Services, sessions: SessionService, state: StateService, dataRoot: string;
beforeEach(() => {
  db = openDatabase(':memory:');
  dataRoot = mkdtempSync(join(tmpdir(), 'sr-state-service-'));
  services = createServices(db, dataRoot);
  services.models.create({ id: 'model', name: 'Model', providerId: 'provider', modelId: 'model', credentialRef: 'credential-ref' });
  services.presets.create({ ...narrativePreset(), id: 'preset' });
  services.worlds.create({
    id: 'world', specVersion: '0.1', name: 'World', characters: [{ id: 'player', name: 'Player', player_selectable: true }], openings: [{ id: 'start', name: 'Start', content: 'Begin' }],
    stateDefinition: { schema_version: 2, scopes: {} }, state: { day: 1 },
  });
  sessions = services.sessions;
  state = services.state;
  for (const id of ['one', 'two']) sessions.create({
    id, worldId: 'world', presetId: 'preset', apiModelConfigId: 'model', userCharacterId: 'player', state: { reputation: 0 },
  });
});
afterEach(() => { vi.restoreAllMocks(); db.close(); rmSync(dataRoot, { recursive: true, force: true }); });

function append(id: string, parentId?: string, sessionId = 'one') {
  return sessions.appendEntry(sessionId, {
    id, parentId, runId: 'run', type: 'message', role: 'assistant',
    payload: { text: id }, extData: { custom: true },
  });
}

describe('read-only scope snapshots and inheritance', () => {
  it('keeps global runtime state separate from definitions and session state', () => {
    services.worlds.setState('world', { day: 2 });
    sessions.setState('one', { reputation: 10 });
    expect(state.getGlobal('world')).toEqual({ day: 2 });
    expect(state.getSession('one')).toEqual({ reputation: 10 });
    expect(state.getSession('two')).toEqual({ reputation: 0 });
    expect(services.worlds.get('world')!.stateDefinition).toEqual({ schema_version: 2, scopes: {} });
    expect(state.getGlobal('missing')).toBeNull();
    expect(state.getSession('missing')).toBeNull();
    expect(() => state.requireGlobal('missing')).toThrow('WORLD_NOT_FOUND');
    expect(() => state.requireSession('missing')).toThrow('SESSION_NOT_FOUND');
  });

  it('inherits message state through compaction and the linear predecessor chain', () => {
    append('root');
    sessions.setEntryState('one', 'root', [{ key: 'coins', value: 3 }]);
    sessions.appendEntry('one', { id: 'summary', runId: 'compact', type: 'compaction', role: null, payload: { summary: 'Summary' } });
    append('answer');
    expect(state.getMessage('one', 'answer')).toEqual([{ key: 'coins', value: 3 }]);
    sessions.setEntryState('one', 'answer', [{ key: 'coins', value: 99 }]);
    append('continuation');
    expect(state.getMessage('one', 'summary')).toEqual([{ key: 'coins', value: 3 }]);
    expect(state.getMessage('one', 'continuation')).toEqual([{ key: 'coins', value: 99 }]);
    expect(sessions.getEntryState('one', 'continuation')).toBeNull();
    expect(sessions.getEntryState('one', 'answer')).toEqual([{ key: 'coins', value: 99 }]);
  });

  it('distinguishes an empty snapshot from inherited NULL and preserves ancestor snapshots', () => {
    append('root');
    expect(state.getMessage('one', 'root')).toBeNull();
    expect(state.requireMessage('one', 'root')).toBeNull();
    expect(state.getMessage('one', 'missing')).toBeNull();
    expect(() => state.requireMessage('one', 'missing')).toThrow('ENTRY_NOT_FOUND');
    sessions.setEntryState('one', 'root', [{ key: 'coins', value: 3 }]);
    append('child');
    sessions.setEntryState('one', 'child', []);
    expect(state.getMessage('one', 'child')).toEqual([]);
    sessions.setEntryState('one', 'child', null);
    expect(state.getMessage('one', 'child')).toEqual([{ key: 'coins', value: 3 }]);
    expect(sessions.getEntry('one', 'child')!.state).toBeNull();
    expect(sessions.getEntry('one', 'root')!.state).toEqual([{ key: 'coins', value: 3 }]);
  });

  it('never reads another session through a corrupt chain', () => {
    append('root'); append('child');
    append('foreign', undefined, 'two');
    sessions.setEntryState('two', 'foreign', [{ key: 'secret', value: 7 }]);
    db.prepare('UPDATE entries SET parent_id=? WHERE id=?').run('foreign', 'child');
    expect(() => state.getMessage('one', 'child')).toThrow('INVALID_PARENT_CHAIN');
    db.prepare('UPDATE entries SET parent_id=? WHERE id=?').run('child', 'child');
    expect(() => state.getMessage('one', 'child')).toThrow('INVALID_PARENT_CHAIN');
  });
});
