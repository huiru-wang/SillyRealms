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
const entryInput = (id: string) => ({ id, runId: 'run', type: 'message', role: 'assistant', payload: { text: id } });

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
    sessions: services.sessions, worlds: services.worlds, appendEntry: usecases.appendEntry, createSession: usecases.createSession, events, canAccessSession, shutdownSignal: shutdown.signal,
  }));
  app.route('/api/v1/state', createStateRoutes({ state: services.state, setState: usecases.setState, sessions: services.sessions, canAccessSession, shutdownSignal: shutdown.signal }));
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
    const created = await data<{ item: SessionView; entry: SessionEntry }>(await request('POST', '/sessions', { ...sessionInput('new'), openingId: 'start', title: 'Start' }), 201);
    expect(created.item).toMatchObject({ id: 'new', worldId: 'world', title: 'Start', tipEntryId: created.entry.id, worldName: 'World', cover: null });
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
      replay_assist_goal: 'Explore', font_size: 19,
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
      sessions: services.sessions, worlds: services.worlds, appendEntry: usecases.appendEntry, createSession: usecases.createSession, events, shutdownSignal: shutdown.signal,
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

  it('keeps entry history linear and does not expose metrics or ancestry editing', async () => {
    const root = await data<{ item: SessionEntry }>(await request('POST', '/sessions/one/entries', entryInput('root')), 201);
    const child = await data<{ item: SessionEntry }>(await request('POST', '/sessions/one/entries', { ...entryInput('child'), parentId: 'root' }), 201);
    expect(child.item).toMatchObject({ parentId: root.item.id, seq: 2 });
    expect(Object.keys(root.item).some(key => key.includes('_'))).toBe(false);
    await failure(await request('POST', '/sessions/one/entries', { ...entryInput('branch'), parentId: 'root' }), 'TIP_CONFLICT', 409);
    expect(services.sessions.get('one')!.tipEntryId).toBe('child');
    for (const path of ['/sessions/one/entries', '/sessions/one/entries/child', '/sessions/one/narrative/runs/run']) {
      expect((await request('GET', path)).status).toBe(404);
    }
    expect((await data<{ item: SessionEntry }>(await request('PATCH', '/sessions/one/entries/child', { payload: { text: 'Edited' } }))).item.payload).toEqual({ text: 'Edited' });
    await failure(await request('PATCH', '/sessions/one/entries/child', { parentId: null }), 'INVALID_REQUEST', 400);
    await failure(await request('POST', '/sessions/one/entries', { ...entryInput('metrics'), metrics: null }), 'INVALID_REQUEST', 400);
    await failure(await request('PATCH', '/sessions/one/entries/child', { metrics: null }), 'INVALID_REQUEST', 400);
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
    services.sessions.appendEntry('blocked', { ...entryInput('secret'), type: 'message', role: 'assistant' });
    access = id => id === 'one';
    expect((await data<Page<SessionSummary>>(await request('GET', '/sessions'))).items.map(item => item.id)).toEqual(['one']);
    const checks: [string, string, unknown?][] = [
      ['GET', '/sessions/blocked'],
      ['PATCH', '/sessions/blocked', { title: 'Overwritten' }],
      ['DELETE', '/sessions/blocked'],
      ['POST', '/sessions/blocked/entries', entryInput('leak')],
      ['PATCH', '/sessions/blocked/entries/secret', { payload: { text: 'Overwritten' } }],
      ['GET', '/sessions/blocked/events'],
      ['GET', '/state/session/blocked'],
      ['PUT', '/state/session/blocked', { state: { leaked: true } }],
      ['PATCH', '/state/session/blocked', { updates: [] }],
      ['GET', '/state/message/blocked/secret'],
      ['PUT', '/state/message/blocked/secret', { state: [] }],
      ['PATCH', '/state/message/blocked/secret', { updates: [] }],
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

describe('complete scope snapshot HTTP operations', () => {
  it('replaces global/session snapshots without modifying world definitions or other sessions', async () => {
    expect((await data<{ item: unknown }>(await request('GET', '/state/global/world'))).item).toEqual({ day: 1, weather: 'rain' });
    expect((await data<{ item: unknown }>(await request('PUT', '/state/global/world', { state: { day: 2 } }))).item).toEqual({ day: 2 });
    expect((await data<{ item: unknown }>(await request('PUT', '/state/session/one', { state: { coins: 7 } }))).item).toEqual({ coins: 7 });
    expect((await data<{ item: unknown }>(await request('GET', '/state/session/one'))).item).toEqual({ coins: 7 });
    expect(services.state.getSession('blocked')).toEqual({});
    expect(services.worlds.get('world')!.stateDefinition).toEqual({ schema_version: 2, scopes: {} });
    expect(services.state.getGlobal('world')).toEqual({ day: 2 });
  });

  it('distinguishes missing entries, empty snapshots and valid null inheritance', async () => {
    services.sessions.appendEntry('one', { ...entryInput('root'), type: 'message', role: 'assistant' });
    expect((await data<{ item: unknown }>(await request('GET', '/state/message/one/root'))).item).toBeNull();
    await data(await request('PUT', '/state/message/one/root', { state: [{ key: 'coins', value: 3 }] }));
    services.sessions.appendEntry('one', { ...entryInput('child'), type: 'message', role: 'assistant' });
    expect((await data<{ item: unknown }>(await request('GET', '/state/message/one/child'))).item).toEqual([{ key: 'coins', value: 3 }]);
    await data(await request('PUT', '/state/message/one/child', { state: [] }));
    expect((await data<{ item: unknown }>(await request('GET', '/state/message/one/child'))).item).toEqual([]);
    expect((await data<{ item: unknown }>(await request('PUT', '/state/message/one/child', { state: null }))).item).toBeNull();
    expect((await data<{ item: unknown }>(await request('GET', '/state/message/one/child'))).item).toEqual([{ key: 'coins', value: 3 }]);
    expect(services.sessions.getEntryState('one', 'child')).toBeNull();
    expect(services.sessions.getEntryState('one', 'root')).toEqual([{ key: 'coins', value: 3 }]);
    await failure(await request('GET', '/state/message/one/missing'), 'ENTRY_NOT_FOUND', 404);
    await failure(await request('PUT', '/state/message/one/missing', { state: null }), 'ENTRY_NOT_FOUND', 404);
    await failure(await request('GET', '/state/message/blocked/root'), 'ENTRY_NOT_FOUND', 404);
  });

  it('rejects absent owners, absent state fields and invalid snapshot shapes', async () => {
    services.sessions.appendEntry('one', { ...entryInput('root'), type: 'message', role: 'assistant' });
    for (const [method, path, body, code] of [
      ['GET', '/state/global/missing', undefined, 'WORLD_NOT_FOUND'],
      ['PUT', '/state/global/missing', { state: {} }, 'WORLD_NOT_FOUND'],
      ['GET', '/state/session/missing', undefined, 'SESSION_NOT_FOUND'],
      ['PUT', '/state/session/missing', { state: {} }, 'SESSION_NOT_FOUND'],
    ] as const) await failure(await request(method, path, body), code, 404);
    for (const body of [{}, { state: null }, { state: [] }, { state: 1 }, { state: {}, extra: true }]) {
      await failure(await request('PUT', '/state/session/one', body), 'INVALID_REQUEST', 400);
    }
    for (const body of [{}, { state: {} }, { state: 1 }, { state: null, extra: true }]) {
      await failure(await request('PUT', '/state/message/one/root', body), 'INVALID_REQUEST', 400);
    }
    expect(services.state.getSession('one')).toEqual({ coins: 1, reputation: 0 });
    expect(services.sessions.getEntryState('one', 'root')).toBeNull();
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
    const results = await data<StateWriteResult[]>(await request('PATCH', '/state/session/one', {
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
    expect(await data(await request('PATCH', '/state/global/world', { updates: [{ path: 'day', value: 2 }] }))).toEqual([
      { path: 'day', scope: 'global', success: true, errorCode: null, errorMessage: '' },
    ]);
    expect((await data<{ item: unknown }>(await request('GET', '/state/global/world'))).item).toEqual({ day: 2, weather: 'rain' });
    expect(publish.mock.calls).toEqual([
      ['blocked', { event: 'state.changed', data: { scope: 'global', path: 'day', value: 2 } }],
      ['one', { event: 'state.changed', data: { scope: 'global', path: 'day', value: 2 } }],
    ]);
  });

  it('patches inherited message state on the selected entry and leaves ignored paths inherited', async () => {
    services.sessions.appendEntry('one', { ...entryInput('root'), type: 'message', role: 'assistant' });
    services.sessions.setEntryState('one', 'root', [{ key: 'coins', value: 3 }, { key: 'inventory', value: { keys: 1 } }]);
    services.sessions.appendEntry('one', { ...entryInput('child'), type: 'message', role: 'assistant' });
    const ignored = await data<StateWriteResult[]>(await request('PATCH', '/state/message/one/child', {
      updates: [{ path: 'inventory.missing', value: 2 }, { path: 'coins', value: 3 }],
    }));
    expect(ignored.every(result => result.success)).toBe(true);
    expect(services.sessions.getEntryState('one', 'child')).toBeNull();
    expect(await data(await request('PATCH', '/state/message/one/child', { updates: [{ path: 'inventory.keys', value: 2 }] }))).toEqual([
      { path: 'inventory.keys', scope: 'message', success: true, errorCode: null, errorMessage: '' },
    ]);
    expect(services.sessions.getEntryState('one', 'child')).toEqual([{ key: 'coins', value: 3 }, { key: 'inventory', value: { keys: 2 } }]);
    expect(services.sessions.getEntryState('one', 'root')).toEqual([{ key: 'coins', value: 3 }, { key: 'inventory', value: { keys: 1 } }]);
    await data(await request('PUT', '/state/message/one/child', { state: [] }));
    expect((await data<StateWriteResult[]>(await request('PATCH', '/state/message/one/child', {
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
    ]) await failure(await request('PATCH', '/state/session/one', body), 'INVALID_REQUEST', 400);
    expect(services.state.requireSession('one')).toEqual({ coins: 1, reputation: 0 });
    await failure(await app.request('/api/v1/state/session/one', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{',
    }), 'INVALID_JSON', 400);
    await failure(await app.request('/api/v1/state/session/one', { method: 'PATCH', body: '{}' }), 'UNSUPPORTED_MEDIA_TYPE', 415);
  });

  it('reports unsafe paths as field failures and continues the request', async () => {
    const results = await data<StateWriteResult[]>(await request('PATCH', '/state/session/one', {
      updates: [{ path: '__proto__.polluted', value: true }, { path: 'coins', value: 2 }],
    }));
    expect(results[0]).toMatchObject({ path: '__proto__.polluted', scope: 'session', success: false, errorCode: 'INVALID_STATE_PATH' });
    expect(results[1]).toMatchObject({ path: 'coins', scope: 'session', success: true });
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(services.state.requireSession('one').coins).toBe(2);
  });

  it('checks owner existence and message ownership even for empty batches', async () => {
    services.sessions.appendEntry('one', { ...entryInput('root'), type: 'message', role: 'assistant' });
    for (const path of ['/state/global/world', '/state/session/one', '/state/message/one/root']) {
      expect(await data(await request('PATCH', path, { updates: [] }))).toEqual([]);
    }
    for (const [path, code] of [
      ['/state/global/missing', 'WORLD_NOT_FOUND'],
      ['/state/session/missing', 'SESSION_NOT_FOUND'],
      ['/state/message/missing/root', 'SESSION_NOT_FOUND'],
      ['/state/message/one/missing', 'ENTRY_NOT_FOUND'],
      ['/state/message/blocked/root', 'ENTRY_NOT_FOUND'],
    ]) {
      await failure(await request('PATCH', path!, { updates: [] }), code!, 404);
      await failure(await request('PATCH', path!, { updates: [{ path: 'coins', value: 2 }] }), code!, 404);
    }
  });

  it('rechecks access before PATCH so a deleted session cannot receive updates', async () => {
    let allow!: (value: boolean) => void;
    const pending = new Promise<boolean>(resolve => { allow = resolve; });
    const gate = vi.fn(() => pending);
    access = gate;
    const response = request('PATCH', '/state/session/one', { updates: [{ path: 'coins', value: 2 }] });
    await vi.waitFor(() => expect(gate).toHaveBeenCalledOnce());
    services.sessions.delete('one');
    allow(true);
    await failure(await response, 'SESSION_NOT_FOUND', 404);
  });

  it('mounts only the nine scope endpoints and removes old paths and aggregate views', async () => {
    services.sessions.appendEntry('one', { ...entryInput('root'), type: 'message', role: 'assistant' });
    const application = createApp({ events, services, usecases });
    try {
      for (const [path, snapshot] of [
        ['/state/global/world', { day: 1, weather: 'rain' }],
        ['/state/session/one', { coins: 1, reputation: 0 }],
        ['/state/message/one/root', null],
      ] as const) {
        expect((await data<{ item: unknown }>(await application.request('/api/v1' + path))).item).toEqual(snapshot);
        expect(await data(await application.request('/api/v1' + path, {
          method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ updates: [] }),
        }))).toEqual([]);
        expect((await data<{ item: unknown }>(await application.request('/api/v1' + path, {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: snapshot }),
        }))).item).toEqual(snapshot);
      }
      for (const path of ['/worlds/world/state', '/sessions/one/state', '/sessions/one/entries/root/state', '/state/views']) {
        for (const method of ['GET', 'PUT', 'PATCH']) {
          await failure(await application.request('/api/v1' + path, { method }), 'NOT_FOUND', 404);
        }
      }
    } finally {
      await application.shutdown();
    }
  });
});
