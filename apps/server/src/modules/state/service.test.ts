import { seedMessage } from '../../testing/run-fixtures.js';
import { worldPublication } from '../../testing/fixtures.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, type JsonValue } from '../../infrastructure/database/connection.js';
import { createServices, type Services } from '../../services.js';
import type { SessionService } from '../sessions/service.js';
import { narrativePreset } from '../../testing/fixtures.js';
import type { StateService, StateUpdate } from './service.js';

let db: DatabaseSync, services: Services, sessions: SessionService, state: StateService, dataRoot: string;
beforeEach(() => {
  db = openDatabase(':memory:');
  dataRoot = mkdtempSync(join(tmpdir(), 'sr-state-service-'));
  services = createServices(db, dataRoot);
  services.models.create({ id: 'model', name: 'Model', providerId: 'provider', modelId: 'model', credentialRef: 'credential-ref' });
  services.presets.create({ ...narrativePreset(), id: 'preset' });
  services.worlds.create({
    id: 'world', specVersion: '0.2', publication: worldPublication(), name: 'World', characters: [{ id: 'player', name: 'Player', player_selectable: true }], openings: [{ id: 'start', name: 'Start', content: 'Begin' }],
    stateDefinition: { schema_version: 2, scopes: {} }, state: { day: 1 },
  });
  sessions = services.sessions;
  state = services.state;
  for (const id of ['one', 'two']) sessions.create({
    id, worldId: 'world', runtimeConfig: { narrativePresetId: 'preset', apiModelConfigId: 'model' }, userCharacterId: 'player', state: { reputation: 0 },
  });
});
afterEach(() => { vi.restoreAllMocks(); db.close(); rmSync(dataRoot, { recursive: true, force: true }); });

function append(id: string, parentId?: string, sessionId = 'one') {
  return seedMessage(services, sessionId, {
    id, parentId, runId: id + '-run', type: 'message', role: 'assistant',
    payload: { message: { role: 'assistant', content: id, timestamp: 1 } },
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
    seedMessage(services, 'one', { id: 'summary', runId: 'compact', type: 'compaction', role: null, payload: { summary: 'Summary' } });
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
    expect(state.getMessage('one', 'child')).toBeNull();
    db.prepare('UPDATE entries SET parent_id=? WHERE id=?').run('child', 'child');
    expect(state.getMessage('one', 'child')).toBeNull();
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

  function prepareObject(scope: 'global' | 'session', update: StateUpdate) {
    const world = services.worlds.require('world');
    return state.prepareObjectPatch(scope, scope === 'global' ? world.state : state.requireSession('one'), world.stateDefinition, update);
  }

  function prepareMessage(update: StateUpdate) {
    return state.prepareMessagePatch(state.requireMessage('one', 'child'), services.worlds.require('world').stateDefinition, update);
  }

  it('selects native root values and distinguishes missing paths from explicit null', () => {
    const inventory = { keys: 0, items: ['map'], reward: null, visible: false, title: '' };
    expect(state.selectPaths({ inventory })).toEqual([{ path: 'inventory', value: inventory }]);
    expect(state.selectPaths({ inventory }, ['inventory.reward', 'missing', 'inventory.keys', 'inventory.keys', 'inventory.items', 'inventory.visible', 'inventory.title'])).toEqual([
      { path: 'inventory.reward', value: null }, { path: 'missing' },
      { path: 'inventory.keys', value: 0 }, { path: 'inventory.keys', value: 0 },
      { path: 'inventory.items', value: ['map'] }, { path: 'inventory.visible', value: false }, { path: 'inventory.title', value: '' },
    ]);
    expect(state.selectPaths({ inventory }, [])).toEqual([]);
    expect(() => state.selectPaths({ inventory }, ['inventory.items.0'])).toThrow('INVALID_REQUEST');
  });

  it('prepares independent object and root replacements without persisting', () => {
    const prepared = prepareObject('global', { path: 'profile.nested.value', value: 7 });
    expect(prepared).toEqual({ changed: true, snapshot: { count: 1, profile: { ...profile.initial, nested: { value: 7 } } } });
    expect(state.getGlobal('world')).toEqual({ count: 1, profile: profile.initial });
    const input = { coins: 9 };
    const session = prepareObject('session', { path: 'profile', value: input });
    input.coins = 99;
    expect(session).toEqual({ changed: true, snapshot: { count: 1, profile: { coins: 9 } } });
    expect(state.getSession('one')).toEqual({ count: 1, profile: profile.initial });
  });

  it('ignores missing roots, intermediate nodes and leaves without creating them', () => {
    for (const path of ['missing', 'absent', 'profile.missing', 'profile.optional', 'profile.optional.child', 'profile.coins.child']) {
      expect(prepareObject('global', { path, value: 8 })).toEqual({
        changed: false, snapshot: { count: 1, profile: profile.initial },
      });
    }
    expect(state.getGlobal('world')).toEqual({ count: 1, profile: profile.initial });
  });

  it('ignores paths without a declared root even when a snapshot contains a value', () => {
    services.worlds.setState('world', { unregistered: 3 });
    expect(prepareObject('global', { path: 'unregistered', value: 4 })).toEqual({
      changed: false, snapshot: { unregistered: 3 },
    });
  });

  it('checks type and range without requiring rules for replacement fields or array elements', () => {
    expect(() => prepareObject('global', { path: 'count', value: 11 })).toThrow('STATE_OUT_OF_RANGE');
    expect(() => prepareObject('session', { path: 'count', value: 'invalid' })).toThrow('INVALID_STATE_VALUE');
    expect(prepareMessage({ path: 'profile', value: { coins: 9, unruled: true } }).changed).toBe(true);
    expect(prepareObject('global', { path: 'profile.items', value: [{ name: 'key', extra: true }] }).changed).toBe(true);
    expect(state.getGlobal('world')).toEqual({ count: 1, profile: profile.initial });
    expect(sessions.getEntryState('one', 'child')).toBeNull();
  });

  it('rejects unsafe or unsupported paths even when the root is absent', () => {
    for (const path of ['', 'missing..value', '__proto__.value', 'profile.constructor', 'profile.items[0]', 'profile.items.0.name']) {
      expect(() => prepareObject('global', { path, value: 7 })).toThrow('INVALID_STATE_PATH');
    }
    expect(() => prepareObject('global', { path: 'profile', value: JSON.parse('{"__proto__":{"polluted":true}}') }))
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
    expect(prepareObject('global', { path: 'count', value: 2 })).toEqual({
      changed: true, snapshot: { count: 2, broken: { unruled: true } },
    });
  });

  it('copies inherited message state while leaving the owner and predecessor untouched', () => {
    const prepared = prepareMessage({ path: 'profile.coins', value: 8 });
    expect(prepared).toEqual({
      changed: true,
      snapshot: [{ key: 'count', value: 1 }, { key: 'profile', value: { ...profile.initial, coins: 8 } }],
    });
    expect(sessions.getEntryState('one', 'root')).toEqual([{ key: 'count', value: 1 }, { key: 'profile', value: profile.initial }]);
    expect(sessions.getEntryState('one', 'child')).toBeNull();
  });

  it('never materializes inheritance for ignored or unchanged message writes', () => {
    for (const [path, value] of [['missing', 8], ['profile.optional.child', 8], ['profile.coins', 1]] as const) {
      expect(prepareMessage({ path, value })).toEqual({ changed: false, snapshot: state.requireMessage('one', 'child') });
    }
    sessions.setEntryState('one', 'child', []);
    expect(prepareMessage({ path: 'count', value: 3 })).toEqual({ changed: false, snapshot: [] });
    expect(sessions.getEntryState('one', 'child')).toEqual([]);
  });

  it('preserves unrelated message values without validating their definitions', () => {
    sessions.setEntryState('one', 'root', [{ key: 'count', value: 'invalid number' }, { key: 'profile', value: profile.initial }]);
    expect(prepareMessage({ path: 'profile.coins', value: 8 })).toEqual({
      changed: true,
      snapshot: [{ key: 'count', value: 'invalid number' }, { key: 'profile', value: { ...profile.initial, coins: 8 } }],
    });
  });

  describe('model message update candidates', () => {
    const prepare = (updates: readonly unknown[], allowedRoots: readonly string[] = ['count', 'profile']) =>
      state.prepareMessageUpdates({ sessionId: 'one', parentId: 'child', allowedRoots, updates });

    it('keeps valid rows before and after failures, preserving inherited roots and metadata without writes', () => {
      const inherited: JsonValue[] = [
        { key: 'count', value: 1, authorHint: { visible: true } },
        { key: 'profile', value: profile.initial },
        { key: 'untouched', value: { private: true }, extra: 'retain' },
      ];
      sessions.setEntryState('one', 'root', inherited);
      const prepared = prepare([
        { path: 'count', value: 3, reason: 'Received coins' },
        { path: 'count', value: 99 },
        { path: 'profile', value: { coins: 7, unruled: true } },
        { path: 'profile.coins', value: 7 },
        { path: 'untouched', value: {} },
        { path: 'count', value: 5 },
      ]);
      expect(prepared.results.map(result => result.status)).toEqual([
        'success', 'invalid_value', 'success', 'success', 'invalid_path', 'success',
      ]);
      expect(prepared.results[1]).toMatchObject({ path: 'count', errorCode: 'STATE_OUT_OF_RANGE' });
      expect(prepared.results[4]).toMatchObject({ path: 'untouched', errorCode: 'STATE_ROOT_NOT_ACTIVE' });
      expect(prepared.updates).toEqual([
        { path: 'count', value: 3, reason: 'Received coins' },
        { path: 'profile', value: { coins: 7, unruled: true } },
        { path: 'profile.coins', value: 7 },
        { path: 'count', value: 5 },
      ]);
      expect(prepared).toMatchObject({ changed: true, snapshot: [
        { key: 'count', value: 5, authorHint: { visible: true } },
        { key: 'profile', value: { coins: 7, unruled: true } },
        { key: 'untouched', value: { private: true }, extra: 'retain' },
      ] });
      expect(prepared.change).toEqual({ event: 'state.changed', data: { scope: 'message', path: '', value: {
        count: 5, profile: { coins: 7, unruled: true }, untouched: { private: true },
      } } });
      expect(sessions.getEntryState('one', 'root')).toEqual(inherited);
      expect(sessions.getEntryState('one', 'child')).toBeNull();
      expect(sessions.require('one').tipEntryId).toBe('child');
    });

    it('reports final equality after ordered replacements and keeps equal rows successful', () => {
      const prepared = prepare([{ path: 'count', value: 2 }, { path: 'count', value: 1 }, { path: 'count', value: 1 }]);
      expect(prepared.changed).toBe(false);
      expect(prepared.snapshot).toEqual(state.requireMessage('one', 'child'));
      expect(prepared.results).toEqual([
        { path: 'count', status: 'success' }, { path: 'count', status: 'success' }, { path: 'count', status: 'success' },
      ]);
      expect(prepared.updates).toHaveLength(3);
    });

    it('rejects missing paths and undeclared roots while public field updates continue ignoring them', () => {
      sessions.setEntryState('one', 'root', [
        { key: 'count', value: 1 }, { key: 'profile', value: profile.initial }, { key: 'unregistered', value: 3 },
      ]);
      const paths = ['absent', 'profile.optional.child', 'profile.coins.child', 'unregistered'];
      const prepared = prepare(paths.map(path => ({ path, value: 8 })), ['absent', 'profile', 'unregistered']);
      expect(prepared.changed).toBe(false);
      expect(prepared.updates).toEqual([]);
      expect(prepared.results).toEqual(paths.map(path => ({
        path, status: 'invalid_path', errorCode: 'STATE_NOT_FOUND', statePath: path,
      })));
      expect(prepareMessage({ path: 'profile.optional.child', value: 8 }))
        .toEqual({ snapshot: state.requireMessage('one', 'child'), changed: false });
    });

    it('isolates malformed updates, unsupported paths and forbidden value keys', () => {
      const prepared = prepare([
        [], null, { path: 'count' }, { path: 'count', value: 2, scope: 'global' },
        { path: 'count', value: 2, reason: {} },
        { path: 3, value: 2 }, { path: 'profile.items.0.name', value: 'another' },
        { path: '__proto__.polluted', value: true },
        { path: 'profile', value: JSON.parse('{"__proto__":{"polluted":true}}') },
        { path: 'count', value: 4 },
      ]);
      expect(prepared.results.map(result => result.status)).toEqual([
        'invalid_update', 'invalid_update', 'invalid_update', 'invalid_update', 'invalid_update',
        'invalid_path', 'invalid_path', 'invalid_path', 'invalid_value', 'success',
      ]);
      expect(prepared.updates).toEqual([{ path: 'count', value: 4 }]);
      expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
    });

    it('rejects arrays by index while allowing complete array replacement and permitted null values', () => {
      const items = [{ name: 'soup' }];
      const prepared = prepare([
        { path: 'profile.items[0]', value: { name: 'bad' } },
        { path: 'profile.items', value: items },
        { path: 'profile.nested', value: null },
        { path: 'profile.nested.value', value: 7 },
      ]);
      items[0]!.name = 'changed after processing';
      expect(prepared.results.map(result => result.status)).toEqual(['invalid_path', 'success', 'success', 'invalid_path']);
      expect(prepared.snapshot).toEqual([
        { key: 'count', value: 1 }, { key: 'profile', value: { coins: 1, nested: null, items: [{ name: 'soup' }] } },
      ]);
      expect(prepared.updates).toEqual([
        { path: 'profile.items', value: [{ name: 'soup' }] }, { path: 'profile.nested', value: null },
      ]);
    });

    it('catches an individual processing exception without losing earlier or later rows', () => {
      const broken = { path: 'count', get value(): number { throw new Error('unexpected getter'); } };
      const prepared = prepare([{ path: 'count', value: 2 }, broken, { path: 'profile.coins', value: 5 }]);
      expect(prepared.results.map(result => result.status)).toEqual(['success', 'processing_error', 'success']);
      expect(prepared.results[1]).toMatchObject({ path: 'count', errorCode: 'STATE_UPDATE_PROCESSING_FAILED' });
      expect(prepared.snapshot).toEqual([
        { key: 'count', value: 2 }, { key: 'profile', value: { ...profile.initial, coins: 5 } },
      ]);
      expect(prepared.updates).toHaveLength(2);
    });

    it('never creates state and keeps material lookup failures outside per-row validation', () => {
      expect(prepare([])).toEqual({
        snapshot: state.requireMessage('one', 'child'), changed: false, change: null, updates: [], results: [],
      });
      expect(prepare([{ path: 'count', value: 2 }], []).results[0])
        .toMatchObject({ status: 'invalid_path', errorCode: 'STATE_ROOT_NOT_ACTIVE' });
      sessions.setEntryState('one', 'child', []);
      expect(prepare([{ path: 'count', value: 2 }])).toMatchObject({
        snapshot: [], changed: false, updates: [], results: [{ status: 'invalid_path', errorCode: 'STATE_NOT_FOUND' }],
      });
      expect(() => state.prepareMessageUpdates({
        sessionId: 'missing', parentId: 'child', allowedRoots: ['count'], updates: [],
      })).toThrow('SESSION_NOT_FOUND');
      expect(() => state.prepareMessageUpdates({
        sessionId: 'one', parentId: 'missing', allowedRoots: ['count'], updates: [],
      })).toThrow('ENTRY_NOT_FOUND');
    });
  });

});
