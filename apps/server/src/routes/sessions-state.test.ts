import { seedMessage } from '../testing/run-fixtures.js';
import { worldPublication } from '../testing/fixtures.js';
import { Hono } from 'hono';
import { createApp } from '../app.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../infrastructure/database/connection.js';
import { bindTransaction } from '../infrastructure/database/transaction.js';
import { EventHub } from '../infrastructure/events/event-hub.js';
import type { Page } from '../http/pagination.js';
import { errorHandler, type FailureResponse, type SuccessResponse } from '../http/response.js';
import type { SessionAccessCheck } from '../http/session-access.js';
import { createServices, type Services } from '../services.js';
import type { SessionEntry } from '../modules/sessions/service.js';
import type { StateWriteResult } from '../modules/state/service.js';
import { narrativePreset } from '../testing/fixtures.js';
import { createUsecases } from '../usecases.js';
import { createSessionRoutes, type SessionSummary, type SessionView } from './sessions.js';
import { createStateRoutes } from './state.js';

let db: DatabaseSync, services: Services, app: Hono, dataRoot: string, shutdown: AbortController;
let events: EventHub;
let access: SessionAccessCheck | undefined;
let usecases: ReturnType<typeof createUsecases>;
const sessionInput = (id: string) => ({
  id, worldId: 'world', runtimeConfig: { narrativePresetId: 'preset', apiModelConfigId: 'model' }, userCharacterId: 'player',
});
const entryInput = (id: string) => ({ id, runId: id + '-run', type: 'message', role: 'assistant', payload: { message: { role: 'assistant', content: id, timestamp: 1 } } } as const);

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'sr-session-state-routes-'));
  db = openDatabase(':memory:');
  services = createServices(db, dataRoot);
  events = new EventHub();
  usecases = createUsecases({ services, transaction: bindTransaction(db), events });
  services.presets.create({ ...narrativePreset(), id: 'preset' });
  services.models.create({ id: 'model', name: 'Model', providerId: 'provider', modelId: 'model', credentialRef: 'ref' });
  services.worlds.create({
    id: 'world', specVersion: '0.2', publication: worldPublication(), name: 'World', characters: [{ id: 'player', name: 'Player', player_selectable: true }], openings: [{ id: 'start', name: 'Start', content: 'Begin' }],
    stateDefinition: { schema_version: 2, scopes: {} }, state: { day: 1, weather: 'rain' },
  });
  services.sessions.create({ ...sessionInput('one'), state: { coins: 1, reputation: 0 } });
  services.sessions.create(sessionInput('blocked'));
  shutdown = new AbortController();
  access = undefined;
  const canAccessSession: SessionAccessCheck = (id, request) => access ? access(id, request) : true;
  app = new Hono();
  app.onError(errorHandler);
  app.route('/api/v1/sessions', createSessionRoutes({
    sessions: services.sessions, worlds: services.worlds, createSession: usecases.createSession, events, canAccessSession, shutdownSignal: shutdown.signal,
  }));
  app.route('/api/v1/state', createStateRoutes({ state: usecases.state, sessions: services.sessions, canAccessSession, shutdownSignal: shutdown.signal }));
});
afterEach(async () => {
  shutdown.abort();
  await usecases.narrative.shutdown();
  vi.restoreAllMocks();
  db.close();
  rmSync(dataRoot, { recursive: true, force: true });
});

function request(method: string, path: string, body?: unknown) {
  return app.request('/api/v1' + path, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
}
async function data<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status);
  const body = await response.json() as SuccessResponse<T>;
  expect(body).toMatchObject({ success: true, errorCode: null, errorMessage: '' });
  expect(Object.keys(body).sort()).toEqual(['data', 'errorCode', 'errorMessage', 'success']);
  return body.data;
}
async function failure(response: Response, code: string, status: number) {
  expect(response.status).toBe(status);
  const body = await response.json() as FailureResponse;
  expect(body).toMatchObject({ success: false, errorCode: code, data: null });
  expect(body.errorMessage.length).toBeGreaterThan(0);
  expect(Object.keys(body).sort()).toEqual(['data', 'errorCode', 'errorMessage', 'success']);
  return body;
}

describe('session HTTP operations', () => {
  it('reports the active preset and world sprite capability only for an accessible session', async () => {
    app = createApp({ events, services, usecases, canAccessSession: id => id === 'one' });
    const path = '/runtime/config';
    const response = await request('GET', path);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const deployment = await data<object>(response);
    expect(Object.keys(deployment).sort()).toEqual(['debug', 'stage']);
    const check = async (available: boolean) => {
      const scoped = await request('GET', path + '?sessionId=one');
      expect(scoped.headers.get('cache-control')).toBe('no-store');
      expect(await data(scoped)).toEqual({ ...deployment, capabilities: { characterSprite: { available } } });
    };
    await check(false);
    services.worlds.update('world', { characters: [
      { id: 'player', name: 'Player', player_selectable: true },
      { id: 'keeper', name: 'Keeper', sprites: [{ id: 'default', description: 'At rest', asset: 'https://example.test/keeper.png' }] },
    ] });
    await check(true);
    const { config } = narrativePreset();
    services.presets.update('preset', { config: { ...config, nodes: config.nodes.map(node =>
      node.id === 'characterSprite' ? { ...node, enabled: false } : node) } });
    await check(false);
    services.presets.update('preset', { config: { ...config, nodes: config.nodes.filter(node => node.id !== 'characterSprite') } });
    await check(false);
    for (const id of ['blocked', 'missing', '']) {
      await failure(await request('GET', path + '?sessionId=' + id), 'SESSION_NOT_FOUND', 404);
    }
  });

  it('serves authorized SSE HEAD requests without allocating a stream or subscription', async () => {
    const originalSubscribe = events.subscribe.bind(events);
    const cleanup = vi.fn();
    const subscribe = vi.spyOn(events, 'subscribe').mockImplementation((id, listener) => {
      const unsubscribe = originalSubscribe(id, listener);
      return () => { cleanup(); unsubscribe(); };
    });
    const application = createApp({ events, services, usecases, canAccessSession: id => id === 'one' });
    try {
      const response = await application.request('/api/v1/sessions/one/events', { method: 'HEAD' });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
      expect(response.headers.get('x-accel-buffering')).toBe('no');
      expect(response.body).toBeNull();
      expect(cleanup).not.toHaveBeenCalled();
      expect(subscribe).not.toHaveBeenCalled();
      for (const id of ['blocked', 'missing']) {
        const denied = await application.request('/api/v1/sessions/' + id + '/events', { method: 'HEAD' });
        expect(denied.status).toBe(404);
        expect(denied.body).toBeNull();
      }
      expect(subscribe).not.toHaveBeenCalled();
    } finally {
      await application.shutdown();
    }
  });

  it('uses camel inputs and item wrappers for detail and writes', async () => {
    const created = await data<{ item: SessionView; opening: {runId:string; message: Pick<SessionEntry, 'id'>} }>(await request('POST', '/sessions', { ...sessionInput('new'), openingId: 'start', title: 'Start' }), 201);
    expect(Object.keys(created).sort()).toEqual(['item','opening']);
    expect(Object.keys(created.opening.message).sort()).toEqual(['content','id','role','status','timestamp']);
    expect(created.item).toMatchObject({ id: 'new', worldId: 'world', title: 'Start', tipEntryId: created.opening.message.id, worldName: 'World', cover: null });
    const { item: detail } = await data<{ item: SessionView }>(await request('GET', '/sessions/new'));
    expect(detail).toMatchObject({ id: 'new', runtimeConfig: { narrativePresetId: 'preset', apiModelConfigId: 'model' }, userCharacterId: 'player' });
    expect(detail).not.toHaveProperty('item');
    expect(Object.keys(detail).some(key => key.includes('_'))).toBe(false);
    services.presets.create({ ...narrativePreset('Other'), id: 'other-preset' });
    services.models.create({ id: 'other-model', name: 'Other', providerId: 'provider', modelId: 'other', credentialRef: 'ref' });
    const updated = await data<{ item: SessionView }>(await request('PATCH', '/sessions/new', {
      title: 'Renamed', runtimeConfig: { narrativePresetId: 'other-preset', apiModelConfigId: 'other-model' },
    }));
    expect(updated.item).toMatchObject({ title: 'Renamed', runtimeConfig: { narrativePresetId: 'other-preset', apiModelConfigId: 'other-model' } });
    await failure(await request('PATCH', '/sessions/new', { preset_id: 'preset' }), 'INVALID_REQUEST', 400);
    expect(await data(await request('DELETE', '/sessions/new'))).toEqual({ id: 'new' });
    await failure(await request('GET', '/sessions/new'), 'SESSION_NOT_FOUND', 404);
  });

  it('creates with a reply preset and merges later configuration edits without losing other fields', async () => {
    const reply = services.presets.create(services.presets.getDefault('reply_assist'));
    const input = sessionInput('configured');
    const runtimeConfig = { ...input.runtimeConfig, replyAssistPresetId: reply.id, replyAssistGoal: 'Explore' };
    const { item } = await data<{ item: SessionView }>(await request('POST', '/sessions', {
      ...input, openingId: 'start', runtimeConfig,
    }), 201);
    expect(item.runtimeConfig).toEqual({ ...runtimeConfig, fontSize: 16 });
    await failure(await request('PATCH', '/sessions/configured', { runtimeConfig: { fontSize: 22, replyAssistGoal: 'invalid' } }), 'INVALID_REQUEST', 400);
    await failure(await request('PATCH', '/sessions/configured', { presetId: 'preset' }), 'INVALID_REQUEST', 400);
    const changed = await data<{ item: SessionView }>(await request('PATCH', '/sessions/configured', { runtimeConfig: { fontSize: 19 } }));
    expect(changed.item.runtimeConfig).toEqual({ ...runtimeConfig, fontSize: 19 });
    const saved = await data<{ item: SessionView }>(await request('GET', '/sessions/configured'));
    expect(saved.item.runtimeConfig).toEqual(changed.item.runtimeConfig);
    const row = db.prepare('SELECT runtime_config FROM sessions WHERE id=?').get(item.id);
    expect(JSON.parse(String(row?.runtime_config))).toEqual({
      narrative_preset_id: 'preset', api_model_config_id: 'model', reply_assist_preset_id: reply.id,
      reply_assist_goal: 'Explore', font_size: 19,
    });
    await failure(await request('POST', '/sessions', { ...input, id: 'bad-config', openingId: 'start',
      runtimeConfig: { ...runtimeConfig, replyAssistPresetId: 'preset' } }), 'PRESET_TYPE_MISMATCH', 400);
    expect(services.sessions.get('bad-config')).toBeNull();
  });

  it('filters by worldId and advances a scoped cursor across tied timestamps', async () => {
    services.sessions.delete('one'); services.sessions.delete('blocked');
    services.worlds.create({ id: 'other', specVersion: '0.2', publication: worldPublication(), name: 'Other', characters: [{ id: 'player', name: 'Player', player_selectable: true }], openings: [{ id: 'start', name: 'Start', content: 'Begin' }] });
    vi.spyOn(Date, 'now').mockReturnValue(100);
    for (const id of ['a', 'b', 'c']) services.sessions.create(sessionInput(id));
    services.sessions.create({ ...sessionInput('foreign'), worldId: 'other' });
    app = new Hono();
    app.onError(errorHandler);
    app.route('/api/v1/sessions', createSessionRoutes({
      sessions: services.sessions, worlds: services.worlds, createSession: usecases.createSession, events, shutdownSignal: shutdown.signal,
    }));
    const first = await data<Page<SessionSummary>>(await request('GET', '/sessions?worldId=world&limit=2'));
    expect(first.items.map(item => item.id)).toEqual(['c', 'b']);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTypeOf('string');
    const next = await data<Page<SessionSummary>>(await request('GET', '/sessions?worldId=world&limit=2&cursor=' + first.nextCursor));
    expect(next.items.map(item => item.id)).toEqual(['a']);
    expect(next).toMatchObject({ hasMore: false, nextCursor: null });
    await failure(await request('GET', '/sessions?worldId=other&cursor=' + first.nextCursor), 'INVALID_REQUEST', 400);
    await failure(await request('GET', '/sessions?cursor=' + first.nextCursor), 'INVALID_REQUEST', 400);
    await failure(await request('GET', '/sessions?cursor=invalid'), 'INVALID_REQUEST', 400);
    await failure(await request('GET', '/sessions?limit=1.5'), 'INVALID_REQUEST', 400);
  });

  it('fills authorized pages without losing the lookahead item or exposing hidden rows', async () => {
    services.sessions.delete('one'); services.sessions.delete('blocked');
    vi.spyOn(Date, 'now').mockReturnValue(100);
    for (const id of ['z', 'y', 'x', 'w', 'v', 'u', 't']) services.sessions.create(sessionInput(id));
    access = id => ['y', 'w', 'u'].includes(id);
    const first = await data<Page<SessionSummary>>(await request('GET', '/sessions?limit=2'));
    expect(first.items.map(item => item.id)).toEqual(['y', 'w']);
    expect(first.hasMore).toBe(true);
    const next = await data<Page<SessionSummary>>(await request('GET', '/sessions?limit=2&cursor=' + first.nextCursor));
    expect(next.items.map(item => item.id)).toEqual(['u']);
    expect(next).toMatchObject({ hasMore: false, nextCursor: null });
    access = () => false;
    for (const limit of [-1, 0, 1001]) await failure(await request('GET', '/sessions?limit=' + limit), 'INVALID_REQUEST', 400);
    expect(await data(await request('GET', '/sessions?limit=1'))).toEqual({ items: [], hasMore: false, nextCursor: null });
  });

  it('projects the current world cover once per world in each request without adding it to Session', async () => {
    const requireWorld = vi.spyOn(services.worlds, 'require');
    const first = await data<Page<SessionSummary>>(await request('GET', '/sessions'));
    expect(first.items).toHaveLength(2);
    expect(first.items.every(item => !Object.hasOwn(item, 'state') && !Object.hasOwn(item, 'usage'))).toBe(true);
    expect(first.items.every(item => item.worldName === 'World' && item.cover === null)).toBe(true);
    expect(requireWorld).toHaveBeenCalledTimes(1);
    services.worlds.update('world', { name: 'Current world', cover: 'images/current.png' });
    requireWorld.mockClear();
    const next = await data<Page<SessionSummary>>(await request('GET', '/sessions'));
    expect(next.items.every(item => item.worldName === 'Current world' && item.cover === 'images/current.png')).toBe(true);
    expect(requireWorld).toHaveBeenCalledTimes(1);
    expect(services.sessions.require('one')).not.toHaveProperty('cover');
    expect(services.sessions.require('one')).not.toHaveProperty('worldName');
  });

  it('has no generic HTTP route to append or edit entries', async () => {
    const entry = seedMessage(services, 'one', entryInput('root'));
    expect((await request('POST', '/sessions/one/entries', entryInput('child'))).status).toBe(404);
    expect((await request('PATCH', '/sessions/one/entries/root', { payload: entryInput('edited').payload })).status).toBe(404);
    expect(services.sessions.getHistory('one')).toEqual([entry]);
    for (const path of ['/sessions/one/entries', '/sessions/one/entries/root', '/sessions/one/narrative/runs/run']) {
      expect((await request('GET', path)).status).toBe(404);
    }
  });

  it('rejects invalid JSON, missing fields and references through the normal error envelope', async () => {
    await failure(await request('POST', '/sessions', {}), 'INVALID_REQUEST', 400);
    await failure(await request('POST', '/sessions', { ...sessionInput('invalid'), openingId: 'start', runtimeConfig: { narrativePresetId: 'missing', apiModelConfigId: 'model' } }), 'PRESET_NOT_FOUND', 404);
    await failure(await request('POST', '/sessions', { ...sessionInput('one'), openingId: 'start' }), 'RESOURCE_CONFLICT', 409);
    await failure(await app.request('/api/v1/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }), 'INVALID_JSON', 400);
    await failure(await app.request('/api/v1/sessions', { method: 'POST', body: '{}' }), 'UNSUPPORTED_MEDIA_TYPE', 415);
    await failure(await request('PATCH', '/sessions/one', []), 'INVALID_REQUEST', 400);
    expect(services.sessions.get('invalid')).toBeNull();
  });

  it('filters lists and guards every existing-session route, including state and event access', async () => {
    seedMessage(services, 'blocked', { ...entryInput('secret'), type: 'message', role: 'assistant' });
    access = id => id === 'one';
    expect((await data<Page<SessionSummary>>(await request('GET', '/sessions'))).items.map(item => item.id)).toEqual(['one']);
    const checks: [string, string, unknown?][] = [
      ['GET', '/sessions/blocked'],
      ['PATCH', '/sessions/blocked', { title: 'Overwritten' }],
      ['DELETE', '/sessions/blocked'],
      ['GET', '/sessions/blocked/entries/secret/character-sprites'],
      ['GET', '/sessions/blocked/events'],
      ['POST', '/state/query', { scope: 'session', sessionId: 'blocked' }],
      ['POST', '/state/update', { scope: 'session', sessionId: 'blocked', updates: [] }],
      ['POST', '/state/query', { scope: 'message', sessionId: 'blocked', entryId: 'secret', paths: [] }],
      ['POST', '/state/update', { scope: 'message', sessionId: 'blocked', entryId: 'secret', updates: [] }],
    ];
    for (const [method, path, body] of checks) await failure(await request(method, path, body), 'SESSION_NOT_FOUND', 404);
    expect(services.sessions.get('blocked')!.title).toBeNull();
    expect(services.sessions.getHistory('blocked')).toHaveLength(1);
    expect(services.state.getSession('blocked')).toEqual({});
    expect(services.sessions.getEntry('blocked', 'secret')!.state).toBeNull();
  });

  it('rechecks existence after an async access decision and hides unexpected callback details', async () => {
    let allow!: (value: boolean) => void;
    const pending = new Promise<boolean>(resolve => { allow = resolve; });
    const gate = vi.fn(() => pending);
    access = gate;
    const response = request('PATCH', '/sessions/one', { title: 'After deletion' });
    await vi.waitFor(() => expect(gate).toHaveBeenCalledOnce());
    services.sessions.delete('one');
    allow(true);
    await failure(await response, 'SESSION_NOT_FOUND', 404);
    access = () => { throw new Error('private database or credential detail'); };
    const unexpected = await failure(await request('GET', '/sessions/blocked'), 'INTERNAL_ERROR', 500);
    expect(unexpected.errorMessage).not.toContain('private');
  });
});

describe('state field queries', () => {
  it('returns all root rows or selected paths and distinguishes empty selection', async () => {
    const owner = { scope: 'session', sessionId: 'one' };
    services.sessions.setState('one', { coins: 1, inventory: { items: ['map'], reward: null } });
    expect(await data(await request('POST', '/state/query', owner))).toEqual([
      { path: 'coins', value: 1 }, { path: 'inventory', value: { items: ['map'], reward: null } },
    ]);
    expect(await data(await request('POST', '/state/query', { ...owner, paths: ['inventory.reward', 'inventory.items', 'missing'] }))).toEqual([
      { path: 'inventory.reward', value: null }, { path: 'inventory.items', value: ['map'] }, { path: 'missing' },
    ]);
    expect(await data(await request('POST', '/state/query', { ...owner, paths: [] }))).toEqual([]);
    for (const paths of [null, {}, '', [1], [''], ['coins', 'a..b'], ['constructor'], ['inventory.items[0]']]) {
      await failure(await request('POST', '/state/query', { ...owner, paths }), 'INVALID_REQUEST', 400);
    }
  });

  it('resolves message inheritance and scopes entry ownership', async () => {
    const owner = { scope: 'message', sessionId: 'one', entryId: 'root' };
    seedMessage(services, 'one', entryInput('root'));
    expect(await data(await request('POST', '/state/query', owner))).toEqual([]);
    services.sessions.setEntryState('one', 'root', [{ key: 'coins', value: 3 }]);
    seedMessage(services, 'one', entryInput('child'));
    expect(await data(await request('POST', '/state/query', { ...owner, entryId: 'child' }))).toEqual([{ path: 'coins', value: 3 }]);
    services.sessions.setEntryState('one', 'child', []);
    expect(await data(await request('POST', '/state/query', { ...owner, entryId: 'child' }))).toEqual([]);
    await failure(await request('POST', '/state/query', { ...owner, sessionId: 'blocked', paths: [] }), 'ENTRY_NOT_FOUND', 404);
  });

  it('rejects ambiguous targets and unknown fields for both operations', async () => {
    for (const target of [{}, { scope: 'other' }, { scope: 'global' }, { scope: 'session', sessionId: ' ' },
      { scope: 'global', worldId: 'world', sessionId: 'one' }, { scope: 'message', entryId: 'root' },
      { scope: 'session', sessionId: 'one', extra: 2 }]) {
      await failure(await request('POST', '/state/query', target), 'INVALID_REQUEST', 400);
      await failure(await request('POST', '/state/update', { ...target, updates: [] }), 'INVALID_REQUEST', 400);
    }
  });
});

describe('field state HTTP operations', () => {
  beforeEach(() => {
    const numberDefinition = (root: string) => ({
      type: 'number', initial: 0, description: root, min: 0, max: 20, rules: { [root]: 'Keep the current number.' },
    });
    services.worlds.update('world', {
      stateDefinition: {
        schema_version: 2,
        scopes: {
          global: {
            day: numberDefinition('day'),
            weather: { type: 'string', initial: 'rain', description: 'Weather', rules: { weather: 'Current weather.' } },
          },
          session: { coins: numberDefinition('coins'), reputation: numberDefinition('reputation') },
          message: {
            coins: numberDefinition('coins'),
            inventory: {
              type: 'json', initial: { keys: 1 }, description: 'Inventory',
              rules: { inventory: 'Current inventory.', 'inventory.keys': 'Number of keys.' },
            },
          },
        },
      },
    });
  });

  it('returns ordered field results, ignores missing paths and leaves other roots unchecked', async () => {
    services.sessions.setState('one', { coins: 1, reputation: 'previous invalid value' });
    const results = await data<StateWriteResult[]>(await request('POST', '/state/update', { scope: 'session', sessionId: 'one',
      updates: [
        { path: 'coins', value: 7 },
        { path: 'coins', value: 'invalid number' },
        { path: 'coins', value: 21 },
        { path: 'missing.path', value: 1 },
        { path: 'coins', value: 9 },
      ],
    }));
    expect(results.map(result => [result.path, result.scope, result.success])).toEqual([
      ['coins', 'session', true], ['coins', 'session', false], ['coins', 'session', false],
      ['missing.path', 'session', true], ['coins', 'session', true],
    ]);
    expect(results[1]).toMatchObject({ errorCode: 'INVALID_STATE_VALUE' });
    expect(results[2]).toMatchObject({ errorCode: 'STATE_OUT_OF_RANGE' });
    for (const result of results) {
      if (result.success) expect(result).toMatchObject({ errorCode: null, errorMessage: '' });
      else expect(result.errorMessage.length).toBeGreaterThan(0);
    }
    expect(services.state.requireSession('one')).toEqual({ coins: 9, reputation: 'previous invalid value' });
    expect(services.state.requireSession('blocked')).toEqual({});
    expect(services.state.requireGlobal('world')).toEqual({ day: 1, weather: 'rain' });
  });

  it('publishes changed global fields to all sessions of the world', async () => {
    const publish = vi.spyOn(events, 'publish');
    expect(await data(await request('POST', '/state/update', { scope: 'global', worldId: 'world', updates: [{ path: 'day', value: 2 }] }))).toEqual([
      { path: 'day', scope: 'global', success: true, errorCode: null, errorMessage: '' },
    ]);
    expect(await data(await request('POST', '/state/query', { scope: 'global', worldId: 'world', paths: ['day'] }))).toEqual([{ path: 'day', value: 2 }]);
    expect(publish.mock.calls).toEqual([
      ['blocked', { event: 'state.changed', data: { scope: 'global', path: 'day', value: 2 } }],
      ['one', { event: 'state.changed', data: { scope: 'global', path: 'day', value: 2 } }],
    ]);
  });

  it('patches inherited message state on the selected entry and leaves ignored paths inherited', async () => {
    seedMessage(services, 'one', { ...entryInput('root'), type: 'message', role: 'assistant' });
    services.sessions.setEntryState('one', 'root', [{ key: 'coins', value: 3 }, { key: 'inventory', value: { keys: 1 } }]);
    seedMessage(services, 'one', { ...entryInput('child'), type: 'message', role: 'assistant' });
    const ignored = await data<StateWriteResult[]>(await request('POST', '/state/update', { scope: 'message', sessionId: 'one', entryId: 'child',
      updates: [{ path: 'inventory.missing', value: 2 }, { path: 'coins', value: 3 }],
    }));
    expect(ignored.every(result => result.success)).toBe(true);
    expect(services.sessions.getEntryState('one', 'child')).toBeNull();
    expect(await data(await request('POST', '/state/update', { scope: 'message', sessionId: 'one', entryId: 'child', updates: [{ path: 'inventory.keys', value: 2 }] }))).toEqual([
      { path: 'inventory.keys', scope: 'message', success: true, errorCode: null, errorMessage: '' },
    ]);
    expect(services.sessions.getEntryState('one', 'child')).toEqual([{ key: 'coins', value: 3 }, { key: 'inventory', value: { keys: 2 } }]);
    expect(services.sessions.getEntryState('one', 'root')).toEqual([{ key: 'coins', value: 3 }, { key: 'inventory', value: { keys: 1 } }]);
    services.sessions.setEntryState('one', 'child', []);
    expect((await data<StateWriteResult[]>(await request('POST', '/state/update', { scope: 'message', sessionId: 'one', entryId: 'child',
      updates: [{ path: 'coins', value: 4 }],
    })))[0]!.success).toBe(true);
    expect(services.sessions.getEntryState('one', 'child')).toEqual([]);
  });

  it('validates the full request shape before applying any fields and rejects scope overrides', async () => {
    const valid = { path: 'coins', value: 2 };
    for (const body of [
      {}, { updates: null }, { updates: {} }, { updates: [], extra: true },
      { updates: [null] }, { updates: [[]] }, { updates: [{}] },
      { updates: [{ value: 2 }] }, { updates: [{ path: 'coins' }] },
      { updates: [{ path: 1, value: 2 }] }, { updates: [{ path: '', value: 2 }] },
      { updates: [valid, { ...valid, scope: 'global' }] },
      { updates: [valid, { ...valid, extra: true }] },
    ]) await failure(await request('POST', '/state/update', { scope: 'session', sessionId: 'one', ...body }), 'INVALID_REQUEST', 400);
    expect(services.state.requireSession('one')).toEqual({ coins: 1, reputation: 0 });
    await failure(await app.request('/api/v1/state/update', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    }), 'INVALID_JSON', 400);
    await failure(await app.request('/api/v1/state/update', { method: 'POST', body: '{}' }), 'UNSUPPORTED_MEDIA_TYPE', 415);
  });

  it('reports unsafe paths as field failures and continues the request', async () => {
    const results = await data<StateWriteResult[]>(await request('POST', '/state/update', { scope: 'session', sessionId: 'one',
      updates: [{ path: '__proto__.polluted', value: true }, { path: 'coins', value: 2 }],
    }));
    expect(results[0]).toMatchObject({ path: '__proto__.polluted', scope: 'session', success: false, errorCode: 'INVALID_STATE_PATH' });
    expect(results[1]).toMatchObject({ path: 'coins', scope: 'session', success: true });
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(services.state.requireSession('one').coins).toBe(2);
  });

  it('checks owner existence and message ownership even for empty batches', async () => {
    seedMessage(services, 'one', { ...entryInput('root'), type: 'message', role: 'assistant' });
    const targets = [
      { scope: 'global', worldId: 'world' },
      { scope: 'session', sessionId: 'one' },
      { scope: 'message', sessionId: 'one', entryId: 'root' },
    ];
    for (const target of targets) expect(await data(await request('POST', '/state/update', { ...target, updates: [] }))).toEqual([]);
    for (const [target, code] of [
      [{ scope: 'global', worldId: 'missing' }, 'WORLD_NOT_FOUND'],
      [{ scope: 'session', sessionId: 'missing' }, 'SESSION_NOT_FOUND'],
      [{ scope: 'message', sessionId: 'missing', entryId: 'root' }, 'SESSION_NOT_FOUND'],
      [{ scope: 'message', sessionId: 'one', entryId: 'missing' }, 'ENTRY_NOT_FOUND'],
      [{ scope: 'message', sessionId: 'blocked', entryId: 'root' }, 'ENTRY_NOT_FOUND'],
    ] as const) {
      await failure(await request('POST', '/state/query', { ...target, paths: [] }), code, 404);
      await failure(await request('POST', '/state/update', { ...target, updates: [] }), code, 404);
    }
  });

  it('accepts queries under the run lock and rejects even empty updates', async () => {
    const permit = services.cache.acquireRun({ worldId: 'world', sessionId: 'one', runId: 'held' });
    try {
      const target = { scope: 'session', sessionId: 'one' };
      expect(await data(await request('POST', '/state/query', { ...target, paths: ['coins'] }))).toEqual([{ path: 'coins', value: 1 }]);
      await failure(await request('POST', '/state/update', { ...target, updates: [] }), 'STATE_WRITE_LOCKED', 409);
    } finally {
      services.cache.releaseRun(permit);
    }
  });

  it('rechecks access before updating so a deleted session cannot receive updates', async () => {
    let allow!: (value: boolean) => void;
    const pending = new Promise<boolean>(resolve => { allow = resolve; });
    const gate = vi.fn(() => pending);
    access = gate;
    const response = request('POST', '/state/update', { scope: 'session', sessionId: 'one', updates: [{ path: 'coins', value: 2 }] });
    await vi.waitFor(() => expect(gate).toHaveBeenCalledOnce());
    services.sessions.delete('one');
    allow(true);
    await failure(await response, 'SESSION_NOT_FOUND', 404);
  });

  it('mounts the two POST operations and retires all scope routes', async () => {
    const application = createApp({ events, services, usecases });
    try {
      for (const [operation, options] of [['query', { paths: [] }], ['update', { updates: [] }]] as const) {
        expect(await data(await application.request('/api/v1/state/' + operation, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scope: 'global', worldId: 'world', ...options }),
        }))).toEqual([]);
      }
      for (const path of ['/state/global/world', '/state/session/one', '/state/message/one/root', '/state/views',
        '/worlds/world/state', '/sessions/one/state', '/sessions/one/entries/root/state']) {
        for (const method of ['GET', 'PUT', 'PATCH']) {
          await failure(await application.request('/api/v1' + path, { method }), 'NOT_FOUND', 404);
        }
      }
    } finally {
      await application.shutdown();
    }
  });
});

describe('v15 run API', () => {
  const base = '/api/v1/sessions/one/narrative/runs';
  const post = (body: unknown) => ({method:'POST', headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  it('pages by stable run key, scopes cursors and rejects removed mutation contracts', async () => {
    const application = createApp({events, services, usecases});
    const seed = (id:string) => seedMessage(services, 'one', {id,runId:'r-'+id,role:'user',type:'message',
      timestamp:1,payload:{message:{role:'user',content:id,timestamp:1}}});
    for (const id of ['a','b','c']) seed(id);
    const page = async (suffix: string) => (await (await application.request(base + suffix)).json()).data;
    const first = await page('?limit=1');
    expect(Object.keys(first).sort()).toEqual(['activeRunId','hasMore','items','nextCursor','tipEntryId']);
    expect(first).toMatchObject({activeRunId:null,hasMore:true,tipEntryId:'c',items:[{id:'r-c'}]});
    expect(first.items[0]).toEqual(await page('/r-c'));
    expect(Object.keys(first.items[0]).sort()).toEqual(['assistantEntryId','capabilities','createdAt','finishedAt','id','messages','status','stopReason','usage']);
    const cursor = encodeURIComponent(first.nextCursor);
    seed('d');
    const second = await page('?limit=1&cursor='+cursor);
    expect(second.items[0].id).toBe('r-b');
    // A cursor is a numeric position, so even removal of its boundary row cannot invalidate the next page.
    bindTransaction(db)(() => {
      db.prepare("UPDATE entries SET parent_id='b' WHERE id='d'").run();
      db.prepare("DELETE FROM entries WHERE run_id='r-c'").run();
      db.prepare("DELETE FROM runs WHERE id='r-c'").run();
    });
    expect((await page('?limit=1&cursor='+cursor)).items).toEqual(second.items);
    expect(await page('?cursor='+encodeURIComponent(second.nextCursor))).toMatchObject({hasMore:false,nextCursor:null,items:[{id:'r-a'}]});
    const other = base.replace('/one/', '/blocked/');
    await failure(await application.request(other+'/r-b'),'RUN_NOT_FOUND',404);
    await failure(await application.request(other+'?cursor='+cursor),'INVALID_REQUEST',400);
    for (const query of ['afterSeq=0','beforeSeq=1','unused=1','limit=1&afterSeq=0','limit=6',
      'cursor='+Buffer.from(JSON.stringify({version:1,scope:'narrative:one',position:{beforeSeq:2}})).toString('base64url')]) {
      await failure(await application.request(base+'?'+query),'INVALID_REQUEST',400);
    }
    const before = services.sessions.getHistory('one'), publish = vi.spyOn(events, 'publish');
    const latest = (await page('?limit=1')).items[0];
    for (const invalid of [
      {userEntryId:'d',assistantEntryId:null,expectedTipEntryId:'d'},
      {runId:latest.id,expectedAssistantEntryId:latest.assistantEntryId,expectedTipEntryId:'d',userEntryId:'d'},
    ]) await failure(await application.request(base+'/regenerate',post(invalid)),'INVALID_REQUEST',400);
    expect(services.sessions.getHistory('one')).toEqual(before);
    expect(publish).not.toHaveBeenCalled();
    await application.shutdown();
  });

  it('closes SSE and rejects pending access, health and new submissions when both settlement writes fail', async () => {
    let release!: (ok:boolean) => void, entered!: () => void;
    const checking = new Promise<void>(resolve => { entered = resolve; });
    const application = createApp({events, services, usecases, canAccessSession: (_id,req) => {
      if (req.method !== 'PATCH') return true;
      entered();
      return new Promise(resolve => { release = resolve; });
    }});
    const sse = await application.request('/api/v1/sessions/one/events');
    const closed = sse.text();
    const pending = application.request('/api/v1/sessions/one', {...post({title:'too late'}),method:'PATCH'});
    await checking;
    db.exec("CREATE TRIGGER fail_settlement BEFORE UPDATE OF finished_at ON runs BEGIN SELECT RAISE(ABORT,'disk fault'); END");
    const failed = new Promise<void>(resolve => usecases.storageFailure.addEventListener('abort', () => resolve(), {once:true}));
    const accepted = usecases.narrative.submit({sessionId:'one',expectedTipEntryId:null,input:{text:'Go'}});
    await failed;
    release(true);
    await failure(await pending,'STORAGE_UNAVAILABLE',503);
    await failure(await application.request('/health'),'STORAGE_UNAVAILABLE',503);
    await failure(await application.request(base,post({input:{text:'again'},expectedTipEntryId:accepted.tipEntryId})),'STORAGE_UNAVAILABLE',503);
    const frames = await closed;
    expect(frames).toContain('event: run.created');
    expect(frames).not.toMatch(/event: run\.(stopped|completed|usage)/);
    expect(services.sessions.getRun('one',accepted.runId).status).toBe('running');
    expect(services.sessions.require('one').title).not.toBe('too late');
    await application.shutdown();
  });
});

it('can read the exact committed run over HTTP from inside a terminal subscriber', async () => {
  const application = createApp({events, services, usecases});
  const base = '/api/v1/sessions/one/narrative/runs';
  let started: unknown, usage: unknown;
  const observed = new Promise<{terminal:Record<string,unknown>; detail:Response}>(resolve => {
    events.subscribe('one', event => {
      if (event.event === 'run.created') started = event.data.messages;
      if (event.event === 'run.usage') usage = event.data.usage;
      if (event.event === 'run.stopped') {
        void Promise.resolve(application.request(base+'/'+event.data.runId)).then(detail => resolve({terminal:event.data,detail}));
      }
    });
  });
  const input = {input:{text:'go'},expectedTipEntryId:null};
  const res = await application.request(base,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
  expect(res.status).toBe(202);
  const {data:accepted} = await res.json();
  expect(Object.keys(accepted).sort()).toEqual(['assistantEntryId','deletedMessageIds','runId','tipEntryId','userEntryId','userMessage']);
  const {terminal,detail} = await observed;
  expect(Object.keys(terminal).sort()).toEqual(['assistantEntryId','model','provider','runId','savedMessageIds','sessionId','stop_reason','timestamp','tipEntryId']);
  expect(started).toEqual([accepted.userMessage]);
  expect(detail.status).toBe(200);
  const {data:run} = await detail.json();
  expect(run).toMatchObject({id:accepted.runId,assistantEntryId:accepted.assistantEntryId,status:'stopped',stopReason:terminal.stop_reason,usage,
    messages:[{id:accepted.userEntryId,status:'complete'}]});
  expect(terminal.savedMessageIds).toEqual(run.messages.map((message:{id:string})=>message.id));
  await application.shutdown();
});

it('discards an execution whose session disappeared without recreating storage or announcing a terminal', async () => {
  const notifications: string[] = [];
  events.subscribe('one', event => {
    notifications.push(event.event);
    if (event.event === 'run.created') bindTransaction(db)(() => {
      db.prepare('DELETE FROM runs WHERE session_id=?').run('one');
      db.prepare('DELETE FROM sessions WHERE id=?').run('one');
    });
  });
  const accepted = usecases.narrative.submit({sessionId:'one',expectedTipEntryId:null,input:{text:'Go'}});
  await usecases.narrative.shutdown();
  expect(notifications).not.toContain('run.stopped');
  expect(notifications).not.toContain('run.completed');
  expect(usecases.storageFailure.aborted).toBe(false);
  expect(db.prepare('SELECT id FROM runs WHERE id=?').get(accepted.runId)).toBeUndefined();
});

it('drains the committed terminal through SSE before closing a normally stopped application', async () => {
  const application = createApp({events, services, usecases});
  const stream = await application.request('/api/v1/sessions/one/events');
  const frames = stream.text();
  const accepted = usecases.narrative.submit({sessionId:'one',expectedTipEntryId:null,input:{text:'Go'}});
  await application.shutdown();
  const received = await frames;
  expect(received).toContain('event: run.usage');
  expect(received.indexOf('event: run.stopped')).toBeGreaterThan(received.indexOf('event: run.usage'));
  expect(services.sessions.getRun('one',accepted.runId)).toMatchObject({status:'stopped',stopReason:'server_shutdown'});
});
