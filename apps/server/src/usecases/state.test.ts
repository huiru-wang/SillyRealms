import { seedMessage } from '../testing/run-fixtures.js';
import { worldPublication } from '../testing/fixtures.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { EventHub, type SessionEvent } from '../infrastructure/events/event-hub.js';
import { openDatabase } from '../infrastructure/database/connection.js';
import { bindTransaction } from '../infrastructure/database/transaction.js';
import { createServices, type Services } from '../services.js';
import { narrativePreset } from '../testing/fixtures.js';
import { createStateUsecase, type StateUsecase } from './state.js';

let db: DatabaseSync, services: Services, stateUsecase: StateUsecase, dataRoot: string, events: EventHub;
beforeEach(() => {
  db = openDatabase(':memory:');
  events = new EventHub();
  dataRoot = mkdtempSync(join(tmpdir(), 'sr-state-usecase-'));
  services = createServices(db, dataRoot);
  services.models.create({ id: 'model', name: 'Model', providerId: 'provider', modelId: 'model', credentialRef: 'credential-ref' });
  services.presets.create({ ...narrativePreset(), id: 'preset' });
  services.worlds.create({
    id: 'world', specVersion: '0.2', publication: worldPublication(), name: 'World', characters: [{ id: 'player', name: 'Player', player_selectable: true }], openings: [{ id: 'start', name: 'Start', content: 'Begin' }],
    stateDefinition: { schema_version: 2, scopes: {} }, state: { day: 1, weather: 'rain' },
  });
  for (const id of ['one', 'two']) services.sessions.create({
    id, worldId: 'world', runtimeConfig: { narrativePresetId: 'preset', apiModelConfigId: 'model' }, userCharacterId: 'player',
    state: { reputation: 0, coins: 1 },
  });
  stateUsecase = createStateUsecase({ worlds: services.worlds, sessions: services.sessions, state: services.state, cache: services.cache, transaction: bindTransaction(db), events });
});
afterEach(() => { vi.restoreAllMocks(); db.close(); rmSync(dataRoot, { recursive: true, force: true }); });

function append(id: string) {
  return seedMessage(services, 'one', {
    id, runId: id + '-run', type: 'message', role: 'assistant', payload: { message: { role: 'assistant', content: id, timestamp: 1 } },
  });
}


it('queries multiple fields of the specified entry with one inherited snapshot read', () => {
  append('root');
  services.sessions.setEntryState('one', 'root', [{ key: 'coins', value: 8 }]);
  append('child');
  const read = vi.spyOn(services.sessions, 'inheritedEntryState');
  expect(stateUsecase.query({ scope: 'message', sessionId: 'one', entryId: 'child' }, ['coins', 'other', 'coins'])).toEqual([
    { path: 'coins', value: 8 }, { path: 'other' }, { path: 'coins', value: 8 },
  ]);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith('one', 'child');
});

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
    const result = stateUsecase.update({ scope: 'session', sessionId: 'one' }, [
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
    services.sessions.setState('one', { coins: 1, reputation: 'invalid old value', extra: true });
    expect(stateUsecase.update({ scope: 'session', sessionId: 'one' }, [{ path: 'coins', value: 4 }])).toEqual([
      { path: 'coins', scope: 'session', success: true, errorCode: null, errorMessage: '' },
    ]);
    expect(services.state.requireSession('one')).toEqual({ coins: 4, reputation: 'invalid old value', extra: true });
  });

  it('ignores missing paths in every scope without writing or materializing inherited message state', () => {
    append('root');
    services.sessions.setEntryState('one', 'root', [{ key: 'profile', value: { name: 'Alice', score: 0 } }]);
    append('child');
    services.sessions.setState('one', { coins: 1, profile: { name: 'Alice', score: 0 } });
    const globalWrite = vi.spyOn(services.worlds, 'setState');
    const sessionWrite = vi.spyOn(services.sessions, 'setState');
    const messageWrite = vi.spyOn(services.sessions, 'setEntryState');
    const updates = [
      { path: 'missing', value: 1 },
      { path: 'profile.missing', value: 2 },
      { path: 'profile.missing.child', value: 3 },
    ];
    for (const results of [
      stateUsecase.update({ scope: 'global', worldId: 'world' }, updates),
      stateUsecase.update({ scope: 'session', sessionId: 'one' }, updates),
      stateUsecase.update({ scope: 'message', sessionId: 'one', entryId: 'child' }, updates),
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
    services.sessions.setEntryState('one', 'root', previous);
    append('child');
    stateUsecase.update({ scope: 'message', sessionId: 'one', entryId: 'child' }, [{ path: 'profile.name', value: 'Alice' }]);
    expect(services.sessions.getEntryState('one', 'child')).toBeNull();
    expect(stateUsecase.update({ scope: 'message', sessionId: 'one', entryId: 'child' }, [{ path: 'profile.name', value: 'Bob' }])[0]?.success).toBe(true);
    expect(services.sessions.getEntryState('one', 'root')).toEqual(previous);
    expect(services.sessions.getEntryState('one', 'child')).toEqual([{ key: 'profile', value: { name: 'Bob', score: 0 } }]);
    services.sessions.setEntryState('one', 'child', null);
    expect(services.state.requireMessage('one', 'child')).toEqual(previous);
    services.sessions.setEntryState('one', 'child', []);
    stateUsecase.update({ scope: 'message', sessionId: 'one', entryId: 'child' }, [{ path: 'profile.name', value: 'Carol' }]);
    expect(services.sessions.getEntryState('one', 'child')).toEqual([]);
  });

  it('changes only state and the timestamp of the selected message', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    const entry = seedMessage(services, 'one', {
      id: 'root', runId: 'run', type: 'message', role: 'assistant',
      payload: { message: { role: 'assistant', content: 'Story', timestamp: 100 } },
      state: [{ key: 'coins', value: 1 }],
    });
    vi.mocked(Date.now).mockReturnValue(200);
    expect(stateUsecase.update({ scope: 'message', sessionId: 'one', entryId: entry.id }, [{ path: 'coins', value: 7 }])[0]?.success).toBe(true);
    expect(services.sessions.getEntry('one', entry.id)).toEqual({ ...entry, state: [{ key: 'coins', value: 7 }], updatedAt: 200 });
    expect(services.sessions.require('one').updatedAt).toBe(100);
  });

  it('discards the change and event if the transaction cannot commit', () => {
    const run = bindTransaction(db);
    const usecase = createStateUsecase({
      ...services, events, transaction: work => run(() => { work(); throw new Error('commit failed'); }),
    });
    const notify = vi.spyOn(events, 'publish');
    expect(usecase.update({ scope: 'global', worldId: 'world' }, [{ path: 'day', value: 4 }])[0])
      .toMatchObject({ success: false, errorCode: 'INTERNAL_ERROR' });
    expect(services.state.requireGlobal('world').day).toBe(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('publishes after each commit, isolates failing listeners and preserves field order', () => {
    const order: string[] = [], observedCoins: unknown[] = [];
    const transaction = bindTransaction(db);
    stateUsecase = createStateUsecase({
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
    expect(stateUsecase.update({ scope: 'session', sessionId: 'one' }, [{ path: 'coins', value: 2 }, { path: 'coins', value: 3 }]).every(result => result.success)).toBe(true);
    expect(order).toEqual(['commit', 'first:2', 'second:2', 'commit', 'first:3', 'second:3']);
    expect(observedCoins).toEqual([2, 2, 3, 3]);
    expect(other).not.toHaveBeenCalled();
  });

  it('publishes nested paths only when the current tip inherits the modified entry', () => {
    append('root');
    services.sessions.setEntryState('one', 'root', [{ key: 'profile', value: { name: 'Alice', score: 0 } }]);
    append('child');
    const received: SessionEvent[] = [];
    events.subscribe('one', event => received.push(event));
    stateUsecase.update({ scope: 'message', sessionId: 'one', entryId: 'root' }, [{ path: 'profile.name', value: 'Bob' }]);
    expect(received).toEqual([{ event: 'state.changed', data: { scope: 'message', path: 'profile.name', value: 'Bob' } }]);
    services.sessions.setEntryState('one', 'child', [{ key: 'profile', value: { name: 'Carol', score: 0 } }]);
    received.length = 0;
    expect(stateUsecase.update({ scope: 'message', sessionId: 'one', entryId: 'root' }, [{ path: 'profile.name', value: 'Dave' }])[0]?.success).toBe(true);
    expect(received).toEqual([]);
    expect(services.state.getCurrentMessage('one')).toEqual({ profile: { name: 'Carol', score: 0 } });
  });

  it('does not publish ignored, equal or rejected fields in any scope', () => {
    append('root');
    services.sessions.setEntryState('one', 'root', [{ key: 'coins', value: 1 }]);
    const listener = vi.fn();
    events.subscribe('one', listener);
    expect(stateUsecase.update({ scope: 'global', worldId: 'world' }, [{ path: 'day', value: 1 }, { path: 'missing', value: 2 }]).every(result => result.success)).toBe(true);
    for (const patch of [
      (updates: Parameters<StateUsecase['update']>[1]) => stateUsecase.update({ scope: 'session', sessionId: 'one' }, updates),
      (updates: Parameters<StateUsecase['update']>[1]) => stateUsecase.update({ scope: 'message', sessionId: 'one', entryId: 'root' }, updates),
    ]) {
      expect(patch([{ path: 'coins', value: 1 }, { path: 'missing', value: 2 }, { path: 'coins', value: 99 }, { path: '', value: 1 }])
        .map(result => result.success)).toEqual([true, true, false, false]);
    }
    expect(listener).not.toHaveBeenCalled();
  });

  it('persists complete replacement objects including fields without rule text', () => {
    services.sessions.setState('one', { coins: 1, profile: { name: 'Alice', score: 0 } });
    const result = stateUsecase.update({ scope: 'session', sessionId: 'one' }, [
      { path: 'profile', value: { name: 'Bob', score: 1, unknown: true } },
      { path: 'coins', value: 2 },
    ]);
    expect(result.map(item => item.success)).toEqual([true, true]);
    expect(services.state.requireSession('one')).toEqual({ coins: 2, profile: { name: 'Bob', score: 1, unknown: true } });
  });

  it('rejects absent owners and foreign messages even for an empty update list', () => {
    append('root');
    expect(() => stateUsecase.update({ scope: 'global', worldId: 'missing' }, [])).toThrow('WORLD_NOT_FOUND');
    expect(() => stateUsecase.update({ scope: 'session', sessionId: 'missing' }, [])).toThrow('SESSION_NOT_FOUND');
    expect(() => stateUsecase.update({ scope: 'message', sessionId: 'missing', entryId: 'root' }, [])).toThrow('SESSION_NOT_FOUND');
    expect(() => stateUsecase.update({ scope: 'message', sessionId: 'one', entryId: 'missing' }, [])).toThrow('ENTRY_NOT_FOUND');
    expect(() => stateUsecase.update({ scope: 'message', sessionId: 'two', entryId: 'root' }, [])).toThrow('ENTRY_NOT_FOUND');
    expect(stateUsecase.update({ scope: 'global', worldId: 'world' }, [])).toEqual([]);
    expect(stateUsecase.update({ scope: 'session', sessionId: 'one' }, [])).toEqual([]);
    expect(stateUsecase.update({ scope: 'message', sessionId: 'one', entryId: 'root' }, [])).toEqual([]);
  });
});

describe('effective state events', () => {
  it('broadcasts global changes to every session of this world without list pagination', () => {
    const received: { id: string; event: SessionEvent }[] = [];
    const ids = ['one', 'two'];
    for (let index = 0; index < 101; index++) {
      const id = 'extra-' + index;
      ids.push(id);
      services.sessions.create({ id, worldId: 'world', runtimeConfig: { narrativePresetId: 'preset', apiModelConfigId: 'model' }, userCharacterId: 'player' });
    }
    services.worlds.create({ id: 'other', specVersion: '0.2', publication: worldPublication(), name: 'Other', characters: [{ id: 'player', name: 'Player', player_selectable: true }], openings: [{ id: 'start', name: 'Start', content: 'Begin' }] });
    services.sessions.create({ id: 'foreign', worldId: 'other', runtimeConfig: { narrativePresetId: 'preset', apiModelConfigId: 'model' }, userCharacterId: 'player' });
    const foreign = vi.fn();
    events.subscribe('foreign', foreign);
    for (const id of ids) events.subscribe(id, event => received.push({ id, event }));
    services.worlds.update('world', { stateDefinition: { schema_version: 2, scopes: {
      global: { day: { type: 'number', initial: 1, description: 'Day' } },
    } } });
    stateUsecase.update({ scope: 'global', worldId: 'world' }, [{ path: 'day', value: 2 }]);
    expect(received.map(item => item.id).sort()).toEqual(ids.sort());
    for (const { event } of received) expect(event).toEqual({ event: 'state.changed', data: { scope: 'global', path: 'day', value: 2 } });
    expect(foreign).not.toHaveBeenCalled();
  });

  it('inherits and clears message state across committed runs and rejects a stale parent', () => {
    const appendEntry = (id: string, entry: Parameters<typeof seedMessage>[2]) => seedMessage(services, id, { ...entry, runId: entry.id + '-run' });
    const input = { runId: 'run', type: 'message', role: 'assistant', payload: { message: { role: 'assistant', content: 'State', timestamp: 1 } } } as const;
    appendEntry('one', { ...input, id: 'first', state: [{ key: 'coins', value: 4 }] });
    appendEntry('one', { ...input, id: 'inherited', state: null });
    appendEntry('one', { ...input, id: 'same', state: [{ key: 'coins', value: 4 }] });
    appendEntry('one', { ...input, id: 'clear', state: [] });
    appendEntry('one', { ...input, id: 'empty-inherited' });
    expect(services.state.getCurrentMessage('one')).toEqual({});
    expect(() => appendEntry('one', { ...input, id: 'conflict', parentId: 'first', state: [{ key: 'coins', value: 9 }] })).toThrow('TIP_CONFLICT');
    expect(services.sessions.getEntry('one', 'conflict')).toBeNull();
  });
});
