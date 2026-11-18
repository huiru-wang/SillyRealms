import { Hono } from 'hono';
import { createApp } from '../app.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../database/connection.js';
import { bindTransaction } from '../database/transaction.js';
import { EventHub } from '../events/event-hub.js';
import type { Page } from '../http/pagination.js';
import { errorHandler, type FailureResponse, type SuccessResponse } from '../http/response.js';
import type { SessionAccessCheck } from '../http/session-access.js';
import { createServices, type Services } from '../services.js';
import type { SessionEntry } from '../modules/sessions/service.js';
import { narrativePreset } from '../testing/fixtures.js';
import { createUsecases } from '../usecases.js';
import { createSessionRoutes, type SessionSummary, type SessionView } from './sessions.js';
import { createStateRoutes } from './state.js';

let db: DatabaseSync, services: Services, app: Hono, dataRoot: string, shutdown: AbortController;
let access: SessionAccessCheck | undefined;
let usecases: ReturnType<typeof createUsecases>;
const sessionInput = (id: string) => ({
  id, worldId: 'world', presetId: 'preset', apiModelConfigId: 'model', userCharacterId: 'player',
});
const entryInput = (id: string) => ({ id, runId: 'run', type: 'message', role: 'assistant', payload: { text: id } });

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'sr-session-state-routes-'));
  db = openDatabase(':memory:');
  services = createServices(db, dataRoot);
  usecases = createUsecases({ services, transaction: bindTransaction(db) });
  services.presets.create({ ...narrativePreset(), id: 'preset' });
  services.models.create({ id: 'model', name: 'Model', providerId: 'provider', modelId: 'model', credentialRef: 'ref' });
  services.worlds.create({
    id: 'world', specVersion: '0.1', name: 'World', characters: [{ id: 'player', name: 'Player', player_selectable: true }], openings: [{ id: 'start', name: 'Start', content: 'Begin' }],
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
    sessions: services.sessions, worlds: services.worlds, events: new EventHub(), canAccessSession, shutdownSignal: shutdown.signal,
  }));
  app.route('/api/v1', createStateRoutes({ state: services.state, setState: usecases.setState, sessions: services.sessions, canAccessSession, shutdownSignal: shutdown.signal }));
});
afterEach(() => {
  shutdown.abort();
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
  it('serves authorized SSE HEAD requests without allocating a stream or subscription', async () => {
    const events = new EventHub();
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
      application.shutdown();
    }
  });

  it('uses camel inputs and item wrappers for detail and writes', async () => {
    const created = await data<{ item: SessionView }>(await request('POST', '/sessions', { ...sessionInput('new'), title: 'Start' }), 201);
    expect(created.item).toMatchObject({ id: 'new', worldId: 'world', title: 'Start', tipEntryId: null, worldName: 'World', cover: null });
    const { item: detail } = await data<{ item: SessionView }>(await request('GET', '/sessions/new'));
    expect(detail).toMatchObject({ id: 'new', presetId: 'preset', apiModelConfigId: 'model', userCharacterId: 'player' });
    expect(detail).not.toHaveProperty('item');
    expect(Object.keys(detail).some(key => key.includes('_'))).toBe(false);
    services.presets.create({ ...narrativePreset('Other'), id: 'other-preset' });
    services.models.create({ id: 'other-model', name: 'Other', providerId: 'provider', modelId: 'other', credentialRef: 'ref' });
    const updated = await data<{ item: SessionView }>(await request('PATCH', '/sessions/new', {
      title: 'Renamed', presetId: 'other-preset', apiModelConfigId: 'other-model',
    }));
    expect(updated.item).toMatchObject({ title: 'Renamed', presetId: 'other-preset', apiModelConfigId: 'other-model' });
    await failure(await request('PATCH', '/sessions/new', { preset_id: 'preset' }), 'INVALID_REQUEST', 400);
    expect(await data(await request('DELETE', '/sessions/new'))).toEqual({ id: 'new' });
    await failure(await request('GET', '/sessions/new'), 'SESSION_NOT_FOUND', 404);
  });

  it('filters by worldId and advances a scoped cursor across tied timestamps', async () => {
    services.sessions.delete('one'); services.sessions.delete('blocked');
    services.worlds.create({ id: 'other', specVersion: '0.1', name: 'Other', characters: [{ id: 'player', name: 'Player', player_selectable: true }], openings: [{ id: 'start', name: 'Start', content: 'Begin' }] });
    vi.spyOn(Date, 'now').mockReturnValue(100);
    for (const id of ['a', 'b', 'c']) services.sessions.create(sessionInput(id));
    services.sessions.create({ ...sessionInput('foreign'), worldId: 'other' });
    app = new Hono();
    app.onError(errorHandler);
    app.route('/api/v1/sessions', createSessionRoutes({
      sessions: services.sessions, worlds: services.worlds, events: new EventHub(), shutdownSignal: shutdown.signal,
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
    expect((await data<{ items: SessionEntry[] }>(await request('GET', '/sessions/one/history'))).items.map(item => item.id)).toEqual(['root', 'child']);
    expect((await data<{ items: SessionEntry[] }>(await request('GET', '/sessions/one/entries?afterSeq=1&limit=1'))).items.map(item => item.id)).toEqual(['child']);
    expect((await data<{ items: SessionEntry[] }>(await request('GET', '/sessions/one/runs/run/entries'))).items).toHaveLength(2);
    expect((await data<{ item: SessionEntry }>(await request('PATCH', '/sessions/one/entries/child', { payload: { text: 'Edited' } }))).item.payload).toEqual({ text: 'Edited' });
    expect((await data<{ item: SessionEntry }>(await request('GET', '/sessions/one/entries/child'))).item.parentId).toBe('root');
    await failure(await request('PATCH', '/sessions/one/entries/child', { parentId: null }), 'INVALID_REQUEST', 400);
    await failure(await request('POST', '/sessions/one/entries', { ...entryInput('metrics'), metrics: null }), 'INVALID_REQUEST', 400);
    await failure(await request('PATCH', '/sessions/one/entries/child', { metrics: null }), 'INVALID_REQUEST', 400);
    await failure(await request('GET', '/sessions/blocked/entries/root'), 'ENTRY_NOT_FOUND', 404);
    await failure(await request('GET', '/sessions/one/entries/missing'), 'ENTRY_NOT_FOUND', 404);
  });

  it('rejects invalid JSON, missing fields and references through the normal error envelope', async () => {
    await failure(await request('POST', '/sessions', {}), 'INVALID_REQUEST', 400);
    await failure(await request('POST', '/sessions', { ...sessionInput('invalid'), presetId: 'missing' }), 'PRESET_NOT_FOUND', 404);
    await failure(await request('POST', '/sessions', sessionInput('one')), 'RESOURCE_CONFLICT', 409);
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
      ['GET', '/sessions/blocked/entries'],
      ['POST', '/sessions/blocked/entries', entryInput('leak')],
      ['GET', '/sessions/blocked/entries/secret'],
      ['PATCH', '/sessions/blocked/entries/secret', { payload: { text: 'Overwritten' } }],
      ['GET', '/sessions/blocked/history'],
      ['GET', '/sessions/blocked/runs/run/entries'],
      ['GET', '/sessions/blocked/events'],
      ['GET', '/sessions/blocked/state'],
      ['PUT', '/sessions/blocked/state', { state: { leaked: true } }],
      ['GET', '/sessions/blocked/entries/secret/state'],
      ['PUT', '/sessions/blocked/entries/secret/state', { state: [] }],
    ];
    for (const [method, path, body] of checks) await failure(await request(method, path, body), 'SESSION_NOT_FOUND', 404);
    expect(services.sessions.get('blocked')!.title).toBeNull();
    expect(services.sessions.listEntries('blocked')).toHaveLength(1);
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
    expect((await data<{ item: unknown }>(await request('GET', '/worlds/world/state'))).item).toEqual({ day: 1, weather: 'rain' });
    expect((await data<{ item: unknown }>(await request('PUT', '/worlds/world/state', { state: { day: 2 } }))).item).toEqual({ day: 2 });
    expect((await data<{ item: unknown }>(await request('PUT', '/sessions/one/state', { state: { coins: 7 } }))).item).toEqual({ coins: 7 });
    expect((await data<{ item: unknown }>(await request('GET', '/sessions/one/state'))).item).toEqual({ coins: 7 });
    expect(services.state.getSession('blocked')).toEqual({});
    expect(services.worlds.get('world')!.stateDefinition).toEqual({ schema_version: 2, scopes: {} });
    expect(services.state.getGlobal('world')).toEqual({ day: 2 });
  });

  it('distinguishes missing entries, empty snapshots and valid null inheritance', async () => {
    services.sessions.appendEntry('one', { ...entryInput('root'), type: 'message', role: 'assistant' });
    expect((await data<{ item: unknown }>(await request('GET', '/sessions/one/entries/root/state'))).item).toBeNull();
    await data(await request('PUT', '/sessions/one/entries/root/state', { state: [{ key: 'coins', value: 3 }] }));
    services.sessions.appendEntry('one', { ...entryInput('child'), type: 'message', role: 'assistant' });
    expect((await data<{ item: unknown }>(await request('GET', '/sessions/one/entries/child/state'))).item).toEqual([{ key: 'coins', value: 3 }]);
    await data(await request('PUT', '/sessions/one/entries/child/state', { state: [] }));
    expect((await data<{ item: unknown }>(await request('GET', '/sessions/one/entries/child/state'))).item).toEqual([]);
    expect((await data<{ item: unknown }>(await request('PUT', '/sessions/one/entries/child/state', { state: null }))).item).toBeNull();
    expect((await data<{ item: unknown }>(await request('GET', '/sessions/one/entries/child/state'))).item).toEqual([{ key: 'coins', value: 3 }]);
    expect(services.sessions.getEntryState('one', 'child')).toBeNull();
    expect(services.sessions.getEntryState('one', 'root')).toEqual([{ key: 'coins', value: 3 }]);
    await failure(await request('GET', '/sessions/one/entries/missing/state'), 'ENTRY_NOT_FOUND', 404);
    await failure(await request('PUT', '/sessions/one/entries/missing/state', { state: null }), 'ENTRY_NOT_FOUND', 404);
    await failure(await request('GET', '/sessions/blocked/entries/root/state'), 'ENTRY_NOT_FOUND', 404);
  });

  it('rejects absent owners, absent state fields and invalid snapshot shapes', async () => {
    services.sessions.appendEntry('one', { ...entryInput('root'), type: 'message', role: 'assistant' });
    for (const [method, path, body, code] of [
      ['GET', '/worlds/missing/state', undefined, 'WORLD_NOT_FOUND'],
      ['PUT', '/worlds/missing/state', { state: {} }, 'WORLD_NOT_FOUND'],
      ['GET', '/sessions/missing/state', undefined, 'SESSION_NOT_FOUND'],
      ['PUT', '/sessions/missing/state', { state: {} }, 'SESSION_NOT_FOUND'],
    ] as const) await failure(await request(method, path, body), code, 404);
    for (const body of [{}, { state: null }, { state: [] }, { state: 1 }, { state: {}, extra: true }]) {
      await failure(await request('PUT', '/sessions/one/state', body), 'INVALID_REQUEST', 400);
    }
    for (const body of [{}, { state: {} }, { state: 1 }, { state: null, extra: true }]) {
      await failure(await request('PUT', '/sessions/one/entries/root/state', body), 'INVALID_REQUEST', 400);
    }
    expect(services.state.getSession('one')).toEqual({ coins: 1, reputation: 0 });
    expect(services.sessions.getEntryState('one', 'root')).toBeNull();
  });
});
