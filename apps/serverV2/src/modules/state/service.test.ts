import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../infrastructure/database/connection.js';
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

  it('builds read-only views at an explicit predecessor and never initializes missing message state', () => {
    expect(state.getViews({ worldId: 'world', sessionId: 'one', entryId: null })).toEqual({
      global: { day: 1 }, session: { reputation: 0 }, message: {},
    });
    append('root');
    sessions.setEntryState('one', 'root', [{ key: 'coins', value: 3 }]);
    append('child');
    const views = state.getViews({ worldId: 'world', sessionId: 'one', entryId: 'child' });
    expect(views.message).toEqual({ coins: 3 });
    expect(state.evaluateWhen('getState("coins") === 3 && getState("day") === 1', views)).toBe(true);
    views.message.coins = 99;
    expect(state.getViews({ worldId: 'world', sessionId: 'one', entryId: 'child' }).message).toEqual({ coins: 3 });
    expect(sessions.getEntryState('one', 'child')).toBeNull();
    sessions.setEntryState('one', 'child', []);
    expect(state.getViews({ worldId: 'world', sessionId: 'one', entryId: 'child' }).message).toEqual({});
  });

  it('rejects malformed or duplicate message-state roots instead of interpreting them', () => {
    append('root');
    sessions.setEntryState('one', 'root', [{ key: 'coins', value: 1 }, { key: 'coins', value: 2 }]);
    expect(() => state.getViews({ worldId: 'world', sessionId: 'one', entryId: 'root' })).toThrow('INVALID_NARRATIVE_STATE');
    sessions.setEntryState('one', 'root', [1]);
    expect(() => state.getViews({ worldId: 'world', sessionId: 'one', entryId: 'root' })).toThrow('INVALID_NARRATIVE_STATE');
  });
});

describe('read-only field preparation with state v2 definitions', () => {
  const count = { type: 'number', initial: 1, description: 'Count', rules: { count: 'Keep the count' }, min: 0, max: 10 };
  const profile = {
    type: 'json', initial: { coins: 1, nested: { value: 2 }, items: [{ name: 'key' }] }, description: 'Profile',
    rules: {
      profile: 'Keep the profile', 'profile.coins': 'Coins', 'profile.nested': 'Nested',
      'profile.nested.value': 'Value', 'profile.items': 'Items', 'profile.items[]': 'Item',
      'profile.items[].name': 'Name', 'profile.optional': 'Optional', 'profile.optional.child': 'Child',
    },
  };
  const definitions = { count, profile, absent: { type: 'boolean', initial: false, description: 'Absent', rules: { absent: 'Optional runtime root' } } };

  beforeEach(() => {
    services.worlds.update('world', { stateDefinition: {
      schema_version: 2, scopes: { global: definitions, session: definitions, message: definitions },
    } });
    services.worlds.setState('world', { count: 1, profile: profile.initial });
    sessions.setState('one', { count: 1, profile: profile.initial });
    append('root');
    sessions.setEntryState('one', 'root', [{ key: 'count', value: 1 }, { key: 'profile', value: profile.initial }]);
    append('child');
  });

  it('prepares independent object and root replacements without persisting', () => {
    const prepared = state.prepareGlobalPatch('world', { path: 'profile.nested.value', value: 7 });
    expect(prepared).toEqual({ changed: true, snapshot: { count: 1, profile: { ...profile.initial, nested: { value: 7 } } } });
    expect(state.getGlobal('world')).toEqual({ count: 1, profile: profile.initial });
    const input = { coins: 9 };
    const session = state.prepareSessionPatch('one', { path: 'profile', value: input });
    input.coins = 99;
    expect(session).toEqual({ changed: true, snapshot: { count: 1, profile: { coins: 9 } } });
    expect(state.getSession('one')).toEqual({ count: 1, profile: profile.initial });
  });

  it('ignores missing roots, intermediate nodes and leaves without creating them', () => {
    for (const path of ['missing', 'absent', 'profile.missing', 'profile.optional', 'profile.optional.child', 'profile.coins.child']) {
      expect(state.prepareGlobalPatch('world', { path, value: 8 })).toEqual({
        changed: false, snapshot: { count: 1, profile: profile.initial },
      });
    }
    expect(state.getGlobal('world')).toEqual({ count: 1, profile: profile.initial });
  });

  it('ignores paths without a declared root even when a snapshot contains a value', () => {
    services.worlds.setState('world', { unregistered: 3 });
    expect(state.prepareGlobalPatch('world', { path: 'unregistered', value: 4 })).toEqual({
      changed: false, snapshot: { unregistered: 3 },
    });
  });

  it('validates only the affected root type, range and complete rules coverage', () => {
    expect(() => state.prepareGlobalPatch('world', { path: 'count', value: 11 })).toThrow('STATE_OUT_OF_RANGE');
    expect(() => state.prepareSessionPatch('one', { path: 'count', value: 'invalid' })).toThrow('INVALID_STATE_VALUE');
    expect(() => state.prepareMessagePatch('one', 'child', { path: 'profile', value: { coins: 9, unruled: true } }))
      .toThrow('STATE_RULE_MISSING: message.profile.unruled');
    expect(() => state.prepareGlobalPatch('world', { path: 'profile.items', value: [{ name: 'key', extra: true }] }))
      .toThrow('STATE_RULE_MISSING: global.profile.items[].extra');
    expect(state.getGlobal('world')).toEqual({ count: 1, profile: profile.initial });
    expect(sessions.getEntryState('one', 'child')).toBeNull();
  });

  it('rejects unsafe or unsupported paths even when the root is absent', () => {
    for (const path of ['', 'missing..value', '__proto__.value', 'profile.constructor', 'profile.items[0]', 'profile.items.0.name']) {
      expect(() => state.prepareGlobalPatch('world', { path, value: 7 })).toThrow('INVALID_STATE_PATH');
    }
    expect(() => state.prepareGlobalPatch('world', { path: 'profile', value: JSON.parse('{"__proto__":{"polluted":true}}') }))
      .toThrow('INVALID_STATE_KEY');
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });

  it('does not validate unrelated definitions, missing roots or existing values', () => {
    const world = services.worlds.require('world');
    vi.spyOn(services.worlds, 'require').mockReturnValue({
      ...world,
      stateDefinition: { schema_version: 2, scopes: { global: { count, broken: 'invalid definition' }, session: 'invalid scope' } },
      state: { count: 1, broken: { unruled: true } },
    });
    expect(state.prepareGlobalPatch('world', { path: 'count', value: 2 })).toEqual({
      changed: true, snapshot: { count: 2, broken: { unruled: true } },
    });
  });

  it('copies inherited message state while leaving the owner and predecessor untouched', () => {
    const prepared = state.prepareMessagePatch('one', 'child', { path: 'profile.coins', value: 8 });
    expect(prepared).toEqual({
      changed: true,
      snapshot: [{ key: 'count', value: 1 }, { key: 'profile', value: { ...profile.initial, coins: 8 } }],
    });
    expect(sessions.getEntryState('one', 'root')).toEqual([{ key: 'count', value: 1 }, { key: 'profile', value: profile.initial }]);
    expect(sessions.getEntryState('one', 'child')).toBeNull();
  });

  it('never materializes inheritance for ignored or unchanged message writes', () => {
    for (const [path, value] of [['missing', 8], ['profile.optional.child', 8], ['profile.coins', 1]] as const) {
      expect(state.prepareMessagePatch('one', 'child', { path, value })).toEqual({ changed: false, snapshot: null });
    }
    sessions.setEntryState('one', 'child', []);
    expect(state.prepareMessagePatch('one', 'child', { path: 'count', value: 3 })).toEqual({ changed: false, snapshot: [] });
    expect(sessions.getEntryState('one', 'child')).toEqual([]);
  });

  it('preserves unrelated message values without validating their definitions', () => {
    sessions.setEntryState('one', 'root', [{ key: 'count', value: 'invalid number' }, { key: 'profile', value: profile.initial }]);
    expect(state.prepareMessagePatch('one', 'child', { path: 'profile.coins', value: 8 })).toEqual({
      changed: true,
      snapshot: [{ key: 'count', value: 'invalid number' }, { key: 'profile', value: { ...profile.initial, coins: 8 } }],
    });
  });

  it('keeps owner lookup failures distinct from field validation failures', () => {
    expect(() => state.prepareGlobalPatch('missing', { path: 'count', value: 2 })).toThrow('WORLD_NOT_FOUND');
    expect(() => state.prepareSessionPatch('missing', { path: 'count', value: 2 })).toThrow('SESSION_NOT_FOUND');
    expect(() => state.prepareMessagePatch('one', 'missing', { path: 'count', value: 2 })).toThrow('ENTRY_NOT_FOUND');
  });
});
