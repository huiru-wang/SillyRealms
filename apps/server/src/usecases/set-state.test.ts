import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { EventHub, type SessionEvent } from '../infrastructure/events/event-hub.js';
import { createAppendEntry } from './append-entry.js';
import { openDatabase } from '../infrastructure/database/connection.js';
import { bindTransaction } from '../infrastructure/database/transaction.js';
import { createServices, type Services } from '../services.js';
import { narrativePreset } from '../testing/fixtures.js';
import { createSetState, type SetState } from './set-state.js';

let db: DatabaseSync, services: Services, setState: SetState, dataRoot: string, events: EventHub;
beforeEach(() => {
  db = openDatabase(':memory:');
  events = new EventHub();
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
  setState = createSetState({ worlds: services.worlds, sessions: services.sessions, state: services.state, cache: services.cache, transaction: bindTransaction(db), events });
});
afterEach(() => { vi.restoreAllMocks(); db.close(); rmSync(dataRoot, { recursive: true, force: true }); });

function append(id: string) {
  return services.sessions.appendEntry('one', {
    id, runId: 'run', type: 'message', role: 'assistant', payload: { text: id }, extData: { author_key: true },
  });
}


describe('independent state field writes', () => {
  beforeEach(() => {
    const number = (root: string, initial: number) => ({
      type: 'number', initial, min: 0, max: 10, description: root, rules: { [root]: 'Update this value.' },
    });
    const profile = {
      type: 'json', initial: { name: 'Alice', score: 0 }, description: 'Profile',
      rules: { profile: 'Profile state.', 'profile.name': 'Current name.', 'profile.score': 'Current score.' },
    };
    services.worlds.update('world', {
      stateDefinition: {
        schema_version: 2,
        scopes: {
          global: { day: number('day', 1), weather: { type: 'string', initial: 'rain', description: 'Weather', rules: { weather: 'Current weather.' } } },
          session: { coins: number('coins', 1), reputation: number('reputation', 0), profile },
          message: { coins: number('coins', 1), profile },
        },
      },
    });
  });

  it('rolls back only the failed field, keeps earlier commits and continues in input order', () => {
    const notifications: SessionEvent[] = [];
    events.subscribe('one', event => notifications.push(event));
    const persist = services.sessions.setState.bind(services.sessions);
    vi.spyOn(services.sessions, 'setState').mockImplementation((id, value) => {
      const result = persist(id, value);
      if (value.coins === 3) throw new Error('private SQL storage detail');
      return result;
    });
    const result = setState.patchSession('one', [
      { path: 'coins', value: 2 },
      { path: 'coins', value: 3 },
      { path: 'reputation', value: 5 },
      { path: 'coins', value: 99 },
      { path: 'missing', value: 1 },
    ]);
    expect(result.map(item => item.success)).toEqual([true, false, true, false, true]);
    expect(result[1]).toEqual({
      path: 'coins', scope: 'session', success: false, errorCode: 'INTERNAL_ERROR', errorMessage: '服务内部错误',
    });
    expect(result[3]).toMatchObject({
      path: 'coins', scope: 'session', success: false, errorCode: 'STATE_OUT_OF_RANGE',
      stateScope: 'session', statePath: 'coins',
    });
    expect(services.state.requireSession('one')).toEqual({ coins: 2, reputation: 5 });
    expect(services.state.requireSession('two')).toEqual({ coins: 1, reputation: 0 });
    expect(notifications).toEqual([
      { event: 'state.changed', data: { path: 'coins', scope: 'session', value: 2 } },
      { event: 'state.changed', data: { path: 'reputation', scope: 'session', value: 5 } },
    ]);
  });

  it('does not reject an existing field because other scope roots are missing or invalid', () => {
    setState.setSession('one', { coins: 1, reputation: 'invalid old value', extra: true });
    expect(setState.patchSession('one', [{ path: 'coins', value: 4 }])).toEqual([
      { path: 'coins', scope: 'session', success: true, errorCode: null, errorMessage: '' },
    ]);
    expect(services.state.requireSession('one')).toEqual({ coins: 4, reputation: 'invalid old value', extra: true });
  });

  it('ignores missing paths in every scope without writing or materializing inherited message state', () => {
    append('root');
    setState.setMessage('one', 'root', [{ key: 'profile', value: { name: 'Alice', score: 0 } }]);
    append('child');
    setState.setSession('one', { coins: 1, profile: { name: 'Alice', score: 0 } });
    const globalWrite = vi.spyOn(services.worlds, 'setState');
    const sessionWrite = vi.spyOn(services.sessions, 'setState');
    const messageWrite = vi.spyOn(services.sessions, 'setEntryState');
    const updates = [
      { path: 'missing', value: 1 },
      { path: 'profile.missing', value: 2 },
      { path: 'profile.missing.child', value: 3 },
    ];
    for (const results of [
      setState.patchGlobal('world', updates),
      setState.patchSession('one', updates),
      setState.patchMessage('one', 'child', updates),
    ]) {
      expect(results).toHaveLength(3);
      expect(results.every(result => result.success && result.errorCode === null && result.errorMessage === '')).toBe(true);
    }
    expect(globalWrite).not.toHaveBeenCalled();
    expect(sessionWrite).not.toHaveBeenCalled();
    expect(messageWrite).not.toHaveBeenCalled();
    expect(services.sessions.getEntryState('one', 'child')).toBeNull();
    expect(services.state.requireMessage('one', 'child')).toEqual([{ key: 'profile', value: { name: 'Alice', score: 0 } }]);
  });

  it('writes a changed inherited value only to the selected message and preserves the predecessor', () => {
    append('root');
    const previous = [{ key: 'profile', value: { name: 'Alice', score: 0 } }];
    setState.setMessage('one', 'root', previous);
    append('child');
    setState.patchMessage('one', 'child', [{ path: 'profile.name', value: 'Alice' }]);
    expect(services.sessions.getEntryState('one', 'child')).toBeNull();
    expect(setState.patchMessage('one', 'child', [{ path: 'profile.name', value: 'Bob' }])[0]?.success).toBe(true);
    expect(services.sessions.getEntryState('one', 'root')).toEqual(previous);
    expect(services.sessions.getEntryState('one', 'child')).toEqual([{ key: 'profile', value: { name: 'Bob', score: 0 } }]);
    setState.setMessage('one', 'child', null);
    expect(services.state.requireMessage('one', 'child')).toEqual(previous);
    setState.setMessage('one', 'child', []);
    setState.patchMessage('one', 'child', [{ path: 'profile.name', value: 'Carol' }]);
    expect(services.sessions.getEntryState('one', 'child')).toEqual([]);
  });

  it('publishes after each commit, isolates failing listeners and preserves field order', () => {
    const order: string[] = [], observedCoins: unknown[] = [];
    const transaction = bindTransaction(db);
    setState = createSetState({
      worlds: services.worlds, sessions: services.sessions, state: services.state, cache: services.cache, events,
      transaction: work => { const result = transaction(work); order.push('commit'); return result; },
    });
    const other = vi.fn();
    events.subscribe('two', other);
    events.subscribe('one', () => { throw new Error('disconnected subscriber'); });
    for (const connection of ['first', 'second']) events.subscribe('one', event => {
      order.push(connection + ':' + String(event.data.value));
      observedCoins.push(services.state.requireSession('one').coins);
    });
    expect(setState.patchSession('one', [{ path: 'coins', value: 2 }, { path: 'coins', value: 3 }]).every(result => result.success)).toBe(true);
    expect(order).toEqual(['commit', 'first:2', 'second:2', 'commit', 'first:3', 'second:3']);
    expect(observedCoins).toEqual([2, 2, 3, 3]);
    expect(other).not.toHaveBeenCalled();
  });

  it('publishes nested paths only when the current tip inherits the modified entry', () => {
    append('root');
    setState.setMessage('one', 'root', [{ key: 'profile', value: { name: 'Alice', score: 0 } }]);
    append('child');
    const received: SessionEvent[] = [];
    events.subscribe('one', event => received.push(event));
    setState.patchMessage('one', 'root', [{ path: 'profile.name', value: 'Bob' }]);
    expect(received).toEqual([{ event: 'state.changed', data: { scope: 'message', path: 'profile.name', value: 'Bob' } }]);
    setState.setMessage('one', 'child', [{ key: 'profile', value: { name: 'Carol', score: 0 } }]);
    received.length = 0;
    expect(setState.patchMessage('one', 'root', [{ path: 'profile.name', value: 'Dave' }])[0]?.success).toBe(true);
    expect(received).toEqual([]);
    expect(services.state.getCurrentMessage('one')).toEqual({ profile: { name: 'Carol', score: 0 } });
  });

  it('does not publish ignored, equal or rejected fields in any scope', () => {
    append('root');
    setState.setMessage('one', 'root', [{ key: 'coins', value: 1 }]);
    const listener = vi.fn();
    events.subscribe('one', listener);
    expect(setState.patchGlobal('world', [{ path: 'day', value: 1 }, { path: 'missing', value: 2 }]).every(result => result.success)).toBe(true);
    for (const patch of [
      (updates: Parameters<SetState['patchSession']>[1]) => setState.patchSession('one', updates),
      (updates: Parameters<SetState['patchSession']>[1]) => setState.patchMessage('one', 'root', updates),
    ]) {
      expect(patch([{ path: 'coins', value: 1 }, { path: 'missing', value: 2 }, { path: 'coins', value: 99 }, { path: '', value: 1 }])
        .map(result => result.success)).toEqual([true, true, false, false]);
    }
    expect(listener).not.toHaveBeenCalled();
  });

  it('persists complete replacement objects including fields without rule text', () => {
    setState.setSession('one', { coins: 1, profile: { name: 'Alice', score: 0 } });
    const result = setState.patchSession('one', [
      { path: 'profile', value: { name: 'Bob', score: 1, unknown: true } },
      { path: 'coins', value: 2 },
    ]);
    expect(result.map(item => item.success)).toEqual([true, true]);
    expect(services.state.requireSession('one')).toEqual({ coins: 2, profile: { name: 'Bob', score: 1, unknown: true } });
  });

  it('rejects absent owners and foreign messages even for an empty update list', () => {
    append('root');
    expect(() => setState.patchGlobal('missing', [])).toThrow('WORLD_NOT_FOUND');
    expect(() => setState.patchSession('missing', [])).toThrow('SESSION_NOT_FOUND');
    expect(() => setState.patchMessage('missing', 'root', [])).toThrow('SESSION_NOT_FOUND');
    expect(() => setState.patchMessage('one', 'missing', [])).toThrow('ENTRY_NOT_FOUND');
    expect(() => setState.patchMessage('two', 'root', [])).toThrow('ENTRY_NOT_FOUND');
    expect(setState.patchGlobal('world', [])).toEqual([]);
    expect(setState.patchSession('one', [])).toEqual([]);
    expect(setState.patchMessage('one', 'root', [])).toEqual([]);
  });
});

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
      requests: [{ requestId: 'request', modelId: 'actual', provider: 'provider', usage: null }],
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

describe('effective state events', () => {
  it('broadcasts global changes to every session of this world without list pagination', () => {
    const received: { id: string; event: SessionEvent }[] = [];
    const ids = ['one', 'two'];
    for (let index = 0; index < 101; index++) {
      const id = 'extra-' + index;
      ids.push(id);
      services.sessions.create({ id, worldId: 'world', presetId: 'preset', apiModelConfigId: 'model', userCharacterId: 'player' });
    }
    services.worlds.create({ id: 'other', specVersion: '0.1', name: 'Other', characters: [{ id: 'player', name: 'Player', player_selectable: true }], openings: [{ id: 'start', name: 'Start', content: 'Begin' }] });
    services.sessions.create({ id: 'foreign', worldId: 'other', presetId: 'preset', apiModelConfigId: 'model', userCharacterId: 'player' });
    const foreign = vi.fn();
    events.subscribe('foreign', foreign);
    for (const id of ids) events.subscribe(id, event => received.push({ id, event }));
    setState.setGlobal('world', { nullable: null });
    expect(received.map(item => item.id).sort()).toEqual(ids.sort());
    expect(received.every(item => JSON.stringify(item.event) === JSON.stringify({ event: 'state.changed', data: { scope: 'global', path: '', value: { nullable: null } } }))).toBe(true);
    expect(foreign).not.toHaveBeenCalled();
  });

  it('sends whole snapshots for replacement, clear and restored inheritance; null remains a value', () => {
    append('root');
    setState.setMessage('one', 'root', [{ key: 'coins', value: 3 }, { key: 'optional', value: null }]);
    append('child');
    const received: SessionEvent[] = [];
    events.subscribe('one', event => received.push(event));
    setState.setMessage('one', 'child', []);
    setState.setMessage('one', 'child', null);
    setState.setSession('one', {});
    setState.setGlobal('world', {});
    expect(received).toEqual([
      { event: 'state.changed', data: { scope: 'message', path: '', value: {} } },
      { event: 'state.changed', data: { scope: 'message', path: '', value: { coins: 3, optional: null } } },
      { event: 'state.changed', data: { scope: 'session', path: '', value: {} } },
      { event: 'state.changed', data: { scope: 'global', path: '', value: {} } },
    ]);
    received.length = 0;
    setState.setMessage('one', 'child', [{ key: 'optional', value: null }, { key: 'coins', value: 3 }]);
    setState.setMessage('one', 'child', null);
    setState.setSession('one', {});
    setState.setGlobal('world', {});
    services.state.requireGlobal('world');
    services.state.requireSession('one');
    services.state.requireMessage('one', 'child');
    expect(received).toEqual([]);
  });

  it('does not publish a historical replacement hidden by a newer snapshot', () => {
    append('root');
    setState.setMessage('one', 'root', [{ key: 'coins', value: 1 }]);
    append('child');
    setState.setMessage('one', 'child', [{ key: 'coins', value: 2 }]);
    const received = vi.fn();
    events.subscribe('one', received);
    setState.setMessage('one', 'root', [{ key: 'coins', value: 3 }]);
    expect(received).not.toHaveBeenCalled();
    expect(services.state.requireMessage('one', 'root')).toEqual([{ key: 'coins', value: 3 }]);
  });

  it('rolls back replacements and publishes nothing when a write or commit fails', () => {
    const received = vi.fn();
    events.subscribe('one', received);
    const persist = services.worlds.setState.bind(services.worlds);
    vi.spyOn(services.worlds, 'setState').mockImplementation((id, value) => {
      persist(id, value);
      throw new Error('write failed');
    });
    expect(() => setState.setGlobal('world', { day: 2 })).toThrow('write failed');
    expect(services.state.requireGlobal('world')).toEqual({ day: 1, weather: 'rain' });
    const transaction = bindTransaction(db);
    const failing = createSetState({
      worlds: services.worlds, sessions: services.sessions, state: services.state, cache: services.cache, events,
      transaction: work => transaction(() => { work(); throw new Error('commit failed'); }),
    });
    expect(() => failing.setSession('one', { coins: 4 })).toThrow('commit failed');
    expect(services.state.requireSession('one')).toEqual({ coins: 1, reputation: 0 });
    expect(received).not.toHaveBeenCalled();
  });

  it('publishes tip replacement after an entry is saved, and skips inherited or equal state', () => {
    const appendEntry = createAppendEntry({ sessions: services.sessions, state: services.state, events, transaction: bindTransaction(db) });
    const received: SessionEvent[] = [], tips: (string | null)[] = [];
    events.subscribe('one', event => { received.push(event); tips.push(services.sessions.require('one').tipEntryId); });
    const input = { runId: 'run', type: 'message', role: 'assistant', payload: {} } as const;
    appendEntry('one', { ...input, id: 'first', state: [{ key: 'coins', value: 4 }] });
    appendEntry('one', { ...input, id: 'inherited', state: null });
    appendEntry('one', { ...input, id: 'same', state: [{ key: 'coins', value: 4 }] });
    appendEntry('one', { ...input, id: 'clear', state: [] });
    appendEntry('one', { ...input, id: 'empty-inherited' });
    expect(received).toEqual([
      { event: 'state.changed', data: { scope: 'message', path: '', value: { coins: 4 } } },
      { event: 'state.changed', data: { scope: 'message', path: '', value: {} } },
    ]);
    expect(tips).toEqual(['first', 'clear']);
    expect(() => appendEntry('one', { ...input, id: 'conflict', parentId: 'first', state: [{ key: 'coins', value: 9 }] })).toThrow('TIP_CONFLICT');
    expect(received).toHaveLength(2);
    expect(services.sessions.getEntry('one', 'conflict')).toBeNull();
  });
});
