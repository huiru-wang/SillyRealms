import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json, StateScope } from '@sillyrealms/sdk/state-validation';
import { openDatabase } from '../infrastructure/database/database.js';
import { WorldFileStore } from '../infrastructure/world-files/world-file-store.js';
import type { CredentialStore } from '../infrastructure/credentials/store.js';
import { responseEnvelope } from '../common/response-middleware.js';
import { worldRoutes } from './worlds.js';
import { sessionRoutes } from './sessions.js';
import { stateUpdateRoutes } from './state-updates.js';
import { SRRuntime } from '../runtime/sr-runtime.js';
import { applyRuntimeStateUpdate } from '../domain/state/runtime-update.js';
import type { AtomicStateDefinition } from '../domain/state/atomic-state.js';
import { readWorld } from '../repositories/world-repository.js';
import { selectMaterials } from '../runtime/context/materials.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function card() {
  const tracked = () => ({
    type: 'json' as const, initial: { count: 1, label: 'initial' }, description: 'A tracked object',
    rules: { tracked: 'Keep confirmed values', 'tracked.count': 'Confirmed count', 'tracked.label': 'Confirmed label' } as Record<string, string>,
  });
  const openings: Array<{ id: string; name: string; content: string; initial_state?: Record<string, Json> }> = [
    { id: 'opening', name: 'Opening', content: 'The story begins.' },
  ];
  return { spec: 'world_card' as const, spec_version: '0.1' as const, data: {
    name: 'State v2 API fixture', characters: [{ id: 'player', name: 'Player', player_selectable: true }], openings,
    state: { schema_version: 2 as const, scopes: {
      global: { tracked: tracked() }, session: { tracked: tracked() },
      message: { tracked: tracked(), hidden: {
        type: 'number' as const, initial: 0, description: 'SDK-owned counter', rules: { hidden: 'Set by the SDK' },
        load: { mode: 'never' as const },
      } },
    } },
  } };
}

function fixture() {
  const db = openDatabase(':memory:'), dir = mkdtempSync(join(tmpdir(), 'sr-state-api-v2-'));
  const credentials: CredentialStore = { get: async () => 'test-only', set: async () => {}, deleteSync: () => {} };
  const stream = vi.fn(() => { throw new Error('Provider calls are forbidden in route tests'); });
  const runtime = new SRRuntime(db, credentials, { resolve: () => undefined, stream });
  const app = new Hono();
  app.use('*', responseEnvelope);
  app.route('/api/v1/worlds', worldRoutes(db, undefined, new WorldFileStore(dir)));
  app.route('/api/v1/sessions', stateUpdateRoutes(db, runtime));
  app.route('/api/v1/sessions', sessionRoutes(db, id => runtime.busy(id), undefined, undefined, undefined, credentials));
  const events: Array<{ sessionId: string; event: string; data: Record<string, unknown> }> = [];
  runtime.onEvent((sessionId, event, data) => events.push({ sessionId, event, data }));
  db.prepare('INSERT INTO api_model_configs VALUES(?,?,?,?,?,?,?)').run('model', 'Fake model', 'fake', 'fake', 'test-ref', 1, 1);
  db.prepare('UPDATE app_settings SET default_api_model_config_id=?').run('model');
  cleanups.push(async () => { await runtime.shutdown(); db.close(); rmSync(dir, { recursive: true, force: true }); expect(stream).not.toHaveBeenCalled(); });
  const request = async (path: string, init?: RequestInit) => {
    const response = await app.request(path, init);
    return { status: response.status, body: await response.json() };
  };
  const importCard = async (input = card()) => {
    const form = new FormData();
    form.append('file', new File([JSON.stringify(input)], 'fixture.json', { type: 'application/json' }));
    return request('/api/v1/worlds/import', { method: 'POST', body: form });
  };
  const importWorld = async (input = card()) => {
    const result = await importCard(input);
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    return String(result.body.data.item.id);
  };
  const sessionRequest = (worldId: string) => request('/api/v1/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ worldId, openingId: 'opening', userCharacterId: 'player' }),
  });
  const createSession = async (worldId: string) => {
    const result = await sessionRequest(worldId);
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    return result.body.data.item as { id: string; tipEntryId: string };
  };
  const state = async (id: string) => {
    const result = await request('/api/v1/sessions/'+id+'/state');
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    return result.body.data as Record<StateScope, Record<string, Json>>;
  };
  const patch = (id: string, updates: Array<{ path: string; value: Json; scope?: StateScope }>) =>
    request('/api/v1/sessions/'+id+'/state', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ updates }) });
  return { db, runtime, events, request, importCard, importWorld, sessionRequest, createSession, state, patch };
}

describe('state v2 HTTP diagnostics and initialization', () => {
  it.each(['missing', 'cross-root'] as const)('preserves field diagnostics for %s rules on JSON import', async scenario => {
    const f = fixture(), input = card(), rules = input.data.state.scopes.message.tracked.rules;
    if (scenario === 'missing') delete rules['tracked.count'];
    else rules['foreign.count'] = 'Not owned by tracked';
    const result = await f.importCard(input);
    const code = scenario === 'missing' ? 'STATE_RULE_MISSING' : 'INVALID_STATE_RULE_PATH';
    const rulePath = scenario === 'missing' ? 'tracked.count' : 'foreign.count';
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ success: false, errorCode: code, data: { scope: 'message', rulePath } });
    expect(result.body.errorMessage).toBeTypeOf('string');
    expect(f.db.prepare('SELECT count(*) AS n FROM worlds').get()!.n).toBe(0);
  });

  it.each(['__proto__', 'constructor', 'prototype'])('reports dangerous rule key %s as a rule-path error on import', async key => {
    const f = fixture(), input = card();
    input.data.state.scopes.message.tracked.rules = JSON.parse('{"tracked":"Root rule","tracked.count":"Count rule","tracked.label":"Label rule","'+key+'":"Forbidden rule"}');
    expect(Object.hasOwn(input.data.state.scopes.message.tracked.rules, key)).toBe(true);
    const result = await f.importCard(input);
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({
      success: false, errorCode: 'INVALID_STATE_RULE_PATH', data: { scope: 'message', rulePath: key },
    });
    expect(f.db.prepare('SELECT count(*) AS n FROM worlds').get()!.n).toBe(0);
  });

  it('replaces an opening root completely and persists all untouched roots from their initial values', async () => {
    const f = fixture(), input = card();
    input.data.openings[0]!.initial_state = { tracked: { count: 10 } };
    const world = await f.importWorld(input), session = await f.createSession(world);
    const current = await f.state(session.id);
    expect(current.message).toEqual({ tracked: { count: 10 }, hidden: 0 });
    expect(current.session).toEqual({ tracked: { count: 1, label: 'initial' } });
    const entry = f.db.prepare('SELECT state,payload FROM entries WHERE id=?').get(session.tipEntryId)!;
    expect(JSON.parse(String(entry.state))).toEqual([{ key: 'tracked', value: { count: 10 } }, { key: 'hidden', value: 0 }]);
    expect(String(entry.payload)).not.toContain('rules');
  });

  it('rejects uncovered opening fields on import and on session creation without writing any session or entry', async () => {
    const f = fixture(), invalid = card();
    invalid.data.openings[0]!.initial_state = { tracked: { count: 10, unexpected: true } };
    const rejectedImport = await f.importCard(invalid);
    expect(rejectedImport.body).toMatchObject({ success: false, errorCode: 'STATE_RULE_MISSING', data: { scope: 'message', rulePath: 'tracked.unexpected' } });
    expect(f.db.prepare('SELECT count(*) AS n FROM worlds').get()!.n).toBe(0);
    const world = await f.importWorld();
    f.db.prepare('UPDATE worlds SET openings_json=? WHERE id=?').run(JSON.stringify(invalid.data.openings), world);
    const rejectedSession = await f.sessionRequest(world);
    expect(rejectedSession.status).toBe(422);
    expect(rejectedSession.body).toMatchObject({ success: false, errorCode: 'STATE_RULE_MISSING', data: { scope: 'message', rulePath: 'tracked.unexpected' } });
    expect(f.db.prepare('SELECT count(*) AS n FROM sessions').get()!.n).toBe(0);
    expect(f.db.prepare('SELECT count(*) AS n FROM entries').get()!.n).toBe(0);
  });

  it.each(['global', 'session', 'message'] as const)('reports a corrupt %s snapshot instead of returning initial values', async scope => {
    const f = fixture(), world = await f.importWorld(), session = await f.createSession(world);
    const corrupt = { count: 99, unexpected: true };
    if (scope === 'global') f.db.prepare('UPDATE worlds SET state=? WHERE id=?').run(JSON.stringify({ tracked: corrupt }), world);
    else if (scope === 'session') f.db.prepare('UPDATE sessions SET state=? WHERE id=?').run(JSON.stringify({ tracked: corrupt }), session.id);
    else f.db.prepare('UPDATE entries SET state=? WHERE id=?').run(JSON.stringify([{ key: 'tracked', value: corrupt }, { key: 'hidden', value: 0 }]), session.tipEntryId);
    const result = await f.request('/api/v1/sessions/'+session.id+'/state');
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ success: false, errorCode: 'STATE_RULE_MISSING', data: { scope, rulePath: 'tracked.unexpected' } });
    expect(result.body.data).not.toHaveProperty('message');
    if (scope === 'global') {
      const detail = await f.request('/api/v1/worlds/'+world+'/state');
      expect(detail.body).toMatchObject({ success: false, errorCode: 'STATE_RULE_MISSING', data: { scope, rulePath: 'tracked.unexpected' } });
    }
  });
});

describe('state v2 SDK write boundaries', () => {
  it.each(['global', 'session', 'message'] as const)('commits valid %s items independently and rejects a later invalid replacement without pollution', async scope => {
    const f = fixture(), world = await f.importWorld(), session = await f.createSession(world);
    const result = await f.patch(session.id, [
      { scope, path: 'tracked', value: { count: 2, label: 'saved' } },
      { scope, path: 'tracked', value: { count: 999, unexpected: true } },
      { scope, path: 'tracked.label', value: 'after' },
    ]);
    expect(result.status).toBe(200);
    expect(result.body.success).toBe(true);
    expect(result.body.data).toMatchObject([
      { scope, path: 'tracked', success: true },
      { scope, path: 'tracked', success: false, errorCode: 'STATE_RULE_MISSING', rulePath: 'tracked.unexpected' },
      { scope, path: 'tracked.label', success: true },
    ]);
    expect((await f.state(session.id))[scope].tracked).toEqual({ count: 2, label: 'after' });
    expect(f.events).toEqual([
      { sessionId: session.id, event: 'state.changed', data: { scope, path: 'tracked', value: { count: 2, label: 'saved' } } },
      { sessionId: session.id, event: 'state.changed', data: { scope, path: 'tracked.label', value: 'after' } },
    ]);
  });

  it('allows SDK writes to load=never while the model boundary rejects that unactivated root', async () => {
    const f = fixture(), worldId = await f.importWorld(), session = await f.createSession(worldId);
    const result = await f.patch(session.id, [{ path: 'hidden', value: 5 }]);
    expect(result.body.data[0]).toMatchObject({ success: true, scope: 'message' });
    const views = await f.state(session.id), world = readWorld(f.db.prepare('SELECT * FROM worlds WHERE id=?').get(worldId)!).data;
    const selected = selectMaterials({ world, views, playerId: 'player', input: 'continue', history: [], nodes: [], presetHash: 'test' });
    expect(selected.roots).not.toContain('hidden');
    const workspace = structuredClone(views.message);
    const definitions = world.state!.scopes.message! as Record<string, AtomicStateDefinition>;
    expect(() => applyRuntimeStateUpdate(workspace, definitions, new Set(selected.roots), 'hidden', 6))
      .toThrow('STATE_ROOT_NOT_ACTIVE');
    expect(workspace.hidden).toBe(5);
    expect((await f.state(session.id)).message.hidden).toBe(5);
  });

  it('rejects all scopes while the world is busy and emits no state changes', async () => {
    const f = fixture(), world = await f.importWorld(), session = await f.createSession(world), before = await f.state(session.id);
    vi.spyOn(f.runtime, 'worldBusy').mockImplementation(id => id === world);
    const result = await f.patch(session.id, (['global', 'session', 'message'] as const).map(scope => ({ scope, path: 'tracked.count', value: 50 })));
    expect(result.body.data).toMatchObject((['global', 'session', 'message'] as const).map(scope => ({ scope, success: false, errorCode: 'WORLD_BUSY' })));
    expect(await f.state(session.id)).toEqual(before);
    expect(f.events).toEqual([]);
  });

  it('identifies a corrupt global snapshot when a session-scope write cannot proceed', async () => {
    const f = fixture(), world = await f.importWorld(), session = await f.createSession(world);
    const before = f.db.prepare('SELECT state FROM sessions WHERE id=?').get(session.id);
    f.db.prepare('UPDATE worlds SET state=? WHERE id=?').run(JSON.stringify({ tracked: { count: 99, unexpected: true } }), world);
    const result = await f.patch(session.id, [{ scope: 'session', path: 'tracked.count', value: 8 }]);
    expect(result.body.data).toMatchObject([{
      scope: 'session', path: 'tracked.count', success: false, errorCode: 'STATE_RULE_MISSING',
      stateScope: 'global', rulePath: 'tracked.unexpected',
    }]);
    expect(f.db.prepare('SELECT state FROM sessions WHERE id=?').get(session.id)).toEqual(before);
    expect(f.events).toEqual([]);
  });

  it('broadcasts a committed global leaf only to sessions in the same world with SDK path payloads', async () => {
    const f = fixture(), world = await f.importWorld(), a = await f.createSession(world), b = await f.createSession(world);
    const unrelatedWorld = await f.importWorld(), unrelated = await f.createSession(unrelatedWorld);
    const result = await f.patch(a.id, [{ scope: 'global', path: 'tracked.count', value: 7 }]);
    expect(result.body.data[0].success).toBe(true);
    expect(new Set(f.events.map(event => event.sessionId))).toEqual(new Set([a.id, b.id]));
    expect(f.events).toHaveLength(2);
    for (const event of f.events) expect(event).toMatchObject({ event: 'state.changed', data: { scope: 'global', path: 'tracked.count', value: 7 } });
    expect((await f.state(a.id)).global.tracked).toEqual({ count: 7, label: 'initial' });
    expect((await f.state(b.id)).global.tracked).toEqual({ count: 7, label: 'initial' });
    expect((await f.state(unrelated.id)).global.tracked).toEqual({ count: 1, label: 'initial' });
  });
});
