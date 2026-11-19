import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../infrastructure/database/connection.js';
import { createServices, type Services } from '../services.js';
import { narrativePreset } from '../testing/fixtures.js';
import { createSetState, type SetState } from './set-state.js';

let db: DatabaseSync, services: Services, setState: SetState, dataRoot: string;
beforeEach(() => {
  db = openDatabase(':memory:');
  dataRoot = mkdtempSync(join(tmpdir(), 'sr-set-state-'));
  services = createServices(db, dataRoot);
  services.models.create({ id: 'model', name: 'Model', providerId: 'provider', modelId: 'model', credentialRef: 'credential-ref' });
  services.presets.create({ ...narrativePreset(), id: 'preset' });
  services.worlds.create({
    id: 'world', specVersion: '0.1', name: 'World', characters: [{ id: 'player', name: 'Player', player_selectable: true }], openings: [{ id: 'start', name: 'Start', content: 'Begin' }],
    stateDefinition: { schema_version: 2, scopes: {} }, state: { day: 1, weather: 'rain' },
  });
  for (const id of ['one', 'two']) services.sessions.create({
    id, worldId: 'world', presetId: 'preset', apiModelConfigId: 'model', userCharacterId: 'player',
    state: { reputation: 0, coins: 1 },
  });
  setState = createSetState({ worlds: services.worlds, sessions: services.sessions });
});
afterEach(() => { vi.restoreAllMocks(); db.close(); rmSync(dataRoot, { recursive: true, force: true }); });

function append(id: string) {
  return services.sessions.appendEntry('one', {
    id, runId: 'run', type: 'message', role: 'assistant', payload: { text: id }, extData: { author_key: true },
  });
}

describe('set-state use case', () => {
  it('replaces each complete scope through its owning service and preserves unrelated data', () => {
    const definition = services.worlds.require('world').stateDefinition;
    expect(setState.setGlobal('world', { world_day: 2 })).toEqual({ world_day: 2 });
    expect(setState.setSession('one', { player_coins: 7 })).toEqual({ player_coins: 7 });
    expect(services.worlds.require('world').state).toEqual({ world_day: 2 });
    expect(services.sessions.require('one').state).toEqual({ player_coins: 7 });
    expect(services.state.requireGlobal('world')).toEqual({ world_day: 2 });
    expect(services.state.requireSession('one')).toEqual({ player_coins: 7 });
    expect(services.state.requireSession('two')).toEqual({ reputation: 0, coins: 1 });
    expect(services.worlds.require('world').stateDefinition).toEqual(definition);
  });

  it('persists explicit empty snapshots and NULL inheritance without changing predecessors', () => {
    append('root');
    expect(setState.setMessage('one', 'root', [{ key: 'coins', value: 3 }])).toEqual([{ key: 'coins', value: 3 }]);
    append('child');
    expect(services.state.requireMessage('one', 'child')).toEqual([{ key: 'coins', value: 3 }]);
    expect(setState.setMessage('one', 'child', [])).toEqual([]);
    expect(services.sessions.getEntryState('one', 'child')).toEqual([]);
    expect(services.state.requireMessage('one', 'child')).toEqual([]);
    expect(setState.setMessage('one', 'child', null)).toBeNull();
    expect(services.sessions.getEntryState('one', 'child')).toBeNull();
    expect(services.state.requireMessage('one', 'child')).toEqual([{ key: 'coins', value: 3 }]);
    expect(services.sessions.getEntryState('one', 'root')).toEqual([{ key: 'coins', value: 3 }]);
    expect(services.sessions.getEntry('one', 'child')!.parentId).toBe('root');
  });

  it('changes only the selected message snapshot and its metadata timestamp', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    const entry = append('root');
    services.sessions.setMetrics('one', entry.id, {
      requests: [{ requestId: 'request', modelId: 'actual', status: 'completed', usage: null }],
    });
    const before = services.sessions.getEntry('one', entry.id)!;
    vi.mocked(Date.now).mockReturnValue(200);
    setState.setMessage('one', entry.id, [{ key: 'inventory', value: { gold_count: 7 } }]);
    expect(services.sessions.getEntry('one', entry.id)).toEqual({
      ...before, state: [{ key: 'inventory', value: { gold_count: 7 } }], updatedAt: 200,
    });
    expect(services.sessions.require('one').updatedAt).toBe(100);
    expect(services.sessions.require('one').tipEntryId).toBe(entry.id);
  });

  it('rejects missing owners and invalid snapshots without mutating stored values', () => {
    append('root');
    expect(() => setState.setGlobal('missing', {})).toThrow('WORLD_NOT_FOUND');
    expect(() => setState.setSession('missing', {})).toThrow('SESSION_NOT_FOUND');
    expect(() => setState.setMessage('one', 'missing', null)).toThrow('ENTRY_NOT_FOUND');
    expect(() => setState.setMessage('two', 'root', [])).toThrow('ENTRY_NOT_FOUND');
    expect(() => setState.setGlobal(' world', {})).toThrow('INVALID_STATE_OWNER');
    expect(() => setState.setSession('', {})).toThrow('INVALID_STATE_OWNER');
    expect(() => setState.setMessage('one', 'root ', null)).toThrow('INVALID_STATE_OWNER');
    expect(() => setState.setGlobal('world', [] as unknown as Parameters<SetState['setGlobal']>[1])).toThrow();
    expect(() => setState.setSession('one', { value: NaN })).toThrow();
    expect(() => setState.setMessage('one', 'root', {} as Parameters<SetState['setMessage']>[2])).toThrow();
    expect(() => setState.setMessage('one', 'root', [undefined] as unknown as Parameters<SetState['setMessage']>[2])).toThrow();
    expect(services.state.requireGlobal('world')).toEqual({ day: 1, weather: 'rain' });
    expect(services.state.requireSession('one')).toEqual({ reputation: 0, coins: 1 });
    expect(services.state.requireMessage('one', 'root')).toBeNull();
  });
});
