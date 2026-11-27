import { worldPublication } from '../testing/fixtures.js';
import { Hono } from 'hono';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../infrastructure/database/connection.js';
import { bindTransaction } from '../infrastructure/database/transaction.js';
import type { SessionAccessCheck } from '../http/session-access.js';
import { EventHub } from '../infrastructure/events/event-hub.js';
import { createWorldUpdates } from '../usecases/world-updates/index.js';
import { createDeleteWorld } from '../usecases/delete-world.js';
import type { Page } from '../http/pagination.js';
import { errorHandler, type SuccessResponse } from '../http/response.js';
import { createServices } from '../services.js';
import { narrativePreset } from '../testing/fixtures.js';
import { createWorldRoutes } from './worlds.js';
import { createImportWorld } from '../usecases/import-world.js';
import { createExportWorld } from '../usecases/export-world.js';
import { unzipBytes, worldCardFixture, zipBytes } from '../modules/worlds/test-fixtures.js';

vi.mock('../modules/worlds/service.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../modules/worlds/service.js')>();
  // Exercise request and file limits with small fixtures.
  return { ...actual, worldImportLimits: { json: 1024, zip: 8192 } };
});

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

type WorldDetail = import('../modules/worlds/service.js').WorldDetail;
type WorldListItem = import('../modules/worlds/service.js').WorldSummary & { sessionCount: number };
let db: DatabaseSync;
let root: string;
let services: ReturnType<typeof createServices>;
let app: Hono;
const base = '/api/v1/worlds';
const content = () => ({ id: 'world-one', name: '雾港', specVersion: '0.2', publication: worldPublication(), characters: [{ id: 'player', name: 'Player', player_selectable: true }], openings: [{ id: 'start', name: 'Start', content: 'Begin' }] });

beforeEach(async () => {
  db = openDatabase(':memory:');
  root = await mkdtemp(join(tmpdir(), 'sr-v2-world-routes-'));
  services = createServices(db, root);
  services.settings.ensure({ defaultPresetId: null, defaultApiModelConfigId: null });
  app = new Hono().onError(errorHandler).route(base, worldRoutes());
});
afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

function worldRoutes(canAccessSession?: SessionAccessCheck, importWorld = createImportWorld(services)) {
  return createWorldRoutes({
    worlds: services.worlds, sessions: services.sessions, canAccessSession,
    deleteWorld: createDeleteWorld({ worlds: services.worlds, sessions: services.sessions, transaction: bindTransaction(db) }),
    importWorld, cache: services.cache, worldUpdates: createWorldUpdates({ ...services, events: new EventHub() }),
    exportWorld: createExportWorld({ worlds: services.worlds }),
  });
}
function sessionWithEntry(worldId: string, id: string, config: ReturnType<typeof configuration>) {
  const session = services.sessions.create({ runtimeConfig: { narrativePresetId: config.presetId, apiModelConfigId: config.apiModelConfigId }, id, worldId, userCharacterId: 'player' });
  const entry = services.sessions.appendEntry(id, {
    id: id + '-entry', runId: 'opening', type: 'message', role: 'assistant', payload: { message: { role: 'assistant', content: 'Opening', timestamp: 1 } },
  });
  return { session, entry };
}
function jsonRequest(path: string, method: string, body: unknown) {
  return app.request(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(method === 'PATCH' ? { expectedRevision: 1, ...(body as object) } : body) });
}
async function data<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status);
  const body = await response.json() as SuccessResponse<T>;
  expect(body).toMatchObject({ success: true, errorCode: null, errorMessage: '' });
  return body.data;
}
async function failure(response: Response, code: string, status: number) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ success: false, errorCode: code, errorMessage: expect.any(String), data: null });
}
function configuration() {
  const preset = services.presets.create(narrativePreset());
  const model = services.models.create({ name: 'model', providerId: 'test', modelId: 'test', credentialRef: 'test' });
  return { presetId: preset.id, apiModelConfigId: model.id };
}
async function resources(worldId: string) {
  await services.worlds.saveOriginal(worldId, 'json', Buffer.from('original-' + worldId));
  const paths = services.worlds.paths(worldId);
  await mkdir(paths.package, { recursive: true });
  await writeFile(join(paths.package, 'resource.txt'), 'package-' + worldId);
  return paths;
}

describe('world routes', () => {
  it('serves sprite declarations in world detail without a separate catalog endpoint', async () => {
    const sprite = { id: 'default', asset: 'sr-asset://assets/player.webp', description: '平静' };
    const world = services.worlds.create({ ...content(), characters: [{ ...content().characters[0], sprites: [sprite] }] });
    const url = base + '/' + world.id;
    expect(await data(await app.request(url))).toMatchObject({ item: { characters: [{ sprites: [sprite] }] } });
    expect((await app.request(url + '/character-sprites')).status).toBe(404);
  });

  it('reads, updates and deletes management details without exposing state', async () => {
    const item = services.worlds.create({ ...content(), state: { coins: 1 }, tags: [' 城市 ', '城市'] });
    expect((await data<{ item: WorldDetail }>(await app.request(base + '/' + item.id))).item.tags).toEqual(['城市']);
    services.worlds.setState(item.id, { coins: 9 });
    const updated = await data<{ item: WorldDetail }>(await jsonRequest('/' + item.id, 'PATCH', { name: '新雾港' }));
    expect(updated.item.name).toBe('新雾港');
    expect(updated.item).not.toHaveProperty('state');
    expect(services.worlds.require(item.id).state).toEqual({ coins: 9 });
    const tagged = await data<{ item: WorldDetail }>(await jsonRequest('/' + item.id, 'PATCH', { expectedRevision: 2, tags: ['港口', ' 城市 ', '港口'] }));
    expect(tagged.item.tags).toEqual(['港口', '城市']);
    expect(await data(await app.request(base + '/tags'))).toEqual({ items: [{ name: '城市', worldCount: 1 }, { name: '港口', worldCount: 1 }] });
    await failure(await jsonRequest('/' + item.id, 'PATCH', { name: 'stale' }), 'WORLD_REVISION_CONFLICT', 409);
    expect(await data(await app.request(base + '/' + item.id, { method: 'DELETE' }))).toEqual({ id: item.id });
    await failure(await app.request(base + '/' + item.id), 'WORLD_NOT_FOUND', 404);
    await failure(await app.request(base + '/' + item.id, { method: 'DELETE' }), 'WORLD_NOT_FOUND', 404);
    await failure(await jsonRequest('/' + item.id, 'PATCH', { name: 'missing' }), 'WORLD_NOT_FOUND', 404);
  });

  it('returns filtered summary cursor pages and batched session counts', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const first = services.worlds.create({ ...content(), id: 'world-c', tags: ['城市'], cover: 'sr-asset://assets/cover.png', extensions: { cover_mosaic_enabled: true } });
    const second = services.worlds.create({ ...content(), id: 'world-a', tags: ['城市'] });
    services.worlds.create({ ...content(), id: 'world-b', tags: ['荒野'] });
    const config = configuration();
    for (const id of ['session-one', 'session-two']) services.sessions.create({ runtimeConfig: { narrativePresetId: config.presetId, apiModelConfigId: config.apiModelConfigId }, id, worldId: first.id, userCharacterId: 'player' });
    const url = base + '?tag=' + encodeURIComponent('城市') + '&q=' + encodeURIComponent('雾') + '&limit=1';
    const firstPage = await data<Page<WorldListItem>>(await app.request(url));
    expect(firstPage.items).toEqual([{ id: first.id, name: first.name, publication: worldPublication(), currentVersion: '1.0.0', latestVersion: null, updateStatus: 'no_source', cover: first.cover, coverMosaicEnabled: true, tags: ['城市'], sessionCount: 2, createdAt: 1000, updatedAt: 1000 }]);
    expect(firstPage.hasMore).toBe(true);
    const lastPage = await data<Page<WorldListItem>>(await app.request(url + '&cursor=' + firstPage.nextCursor));
    expect(lastPage).toEqual({ items: [{ id: second.id, name: second.name, publication: worldPublication(), currentVersion: '1.0.0', latestVersion: null, updateStatus: 'no_source', cover: null, coverMosaicEnabled: false, tags: ['城市'], sessionCount: 0, createdAt: 1000, updatedAt: 1000 }], hasMore: false, nextCursor: null });
    expect(await data(await app.request(base + '?tag=absent'))).toEqual({ items: [], hasMore: false, nextCursor: null });
    await failure(await app.request(base + '?tag=other&cursor=' + firstPage.nextCursor), 'INVALID_REQUEST', 400);
    await failure(await app.request(base + '?cursor=invalid'), 'INVALID_REQUEST', 400);
    await failure(await app.request(base + '?tagId=old'), 'INVALID_REQUEST', 400);
    expect(await data(await app.request(base + '/tags'))).toEqual({ items: [{ name: '城市', worldCount: 2 }, { name: '荒野', worldCount: 1 }] });
  });

  it('exposes and updates only the typed cover flag while preserving foreign extension data', async () => {
    const extensions = { author: { release: 'v1', notes: ['keep'] }, custom: 2 };
    const world = services.worlds.create({ ...content(), extensions });
    const initial = await data<{ item: WorldDetail }>(await app.request(base + '/' + world.id));
    expect(initial.item.coverMosaicEnabled).toBe(false);
    const enabled = await data<{ item: WorldDetail }>(await jsonRequest('/' + world.id, 'PATCH', { coverMosaicEnabled: true }));
    expect(enabled.item).toMatchObject({ coverMosaicEnabled: true, revision: 2, extensions: { ...extensions, cover_mosaic_enabled: true } });
    const page = await data<Page<WorldListItem>>(await app.request(base));
    expect(page.items[0]).toMatchObject({ id: world.id, coverMosaicEnabled: true });
    expect(page.items[0]).not.toHaveProperty('extensions');
    await failure(await jsonRequest('/' + world.id, 'PATCH', { coverMosaicEnabled: false }), 'WORLD_REVISION_CONFLICT', 409);
    const disabled = await data<{ item: WorldDetail }>(await jsonRequest('/' + world.id, 'PATCH', { coverMosaicEnabled: false, expectedRevision: 2 }));
    expect(disabled.item).toMatchObject({ coverMosaicEnabled: false, revision: 3, extensions: { ...extensions, cover_mosaic_enabled: false } });
    for (const body of [
      { coverMosaicEnabled: 'false' }, { coverMosaicEnabled: 1 }, { coverMosaicEnabled: null },
      { extensions: { cover_mosaic_enabled: true } }, { cover_mosaic_enabled: true },
    ]) {
      await failure(await jsonRequest('/' + world.id, 'PATCH', { expectedRevision: 3, ...body }), 'INVALID_REQUEST', 400);
    }
    expect(services.worlds.require(world.id)).toMatchObject({ revision: 3, extensions: disabled.item.extensions, coverMosaicEnabled: false });
  });

  it('projects component and Markdown presentations without runtime state', async () => {
    const { presetId, apiModelConfigId } = configuration();
    const presentation = { type: 'component' as const, component: 'intro' };
    const definition = worldCardFixture().data.state;
    const world = services.worlds.create({
      ...content(), presentation,
      characters: [{ ...content().characters[0], content: 'Only model facts',
        presentation: { type: 'markdown', text: 'Public role introduction' } }],
      openings: [{ ...content().openings[0], presentation }],
      stateDefinition: definition, state: { coins: 7 },
      defaultPresetId: presetId, defaultApiModelConfigId: apiModelConfigId,
      components: [{ id: 'intro', component: 'export default () => null' }], stageComponent: 'intro',
      extensions: { custom_key: 1 },
    });
    const response = await data<{ item: WorldDetail }>(await app.request(base + '/' + world.id));
    expect(response).toMatchObject({ item: {
      id: world.id, specVersion: '0.2', publication: worldPublication(), revision: 1, defaultPresetId: presetId, defaultApiModelConfigId: apiModelConfigId,
      presentation, stateDefinition: definition, stageComponent: 'intro',
      characters: [{ ...content().characters[0], content: 'Only model facts', presentation: { type: 'markdown', text: 'Public role introduction' } }],
      openings: [{ ...content().openings[0], presentation }], extensions: { custom_key: 1 },
    } });
    expect(response.item).not.toHaveProperty('state');
    expect(response.item).not.toHaveProperty('data');
    expect(response.item).not.toHaveProperty('description');
    expect(response.item.characters[0]).not.toHaveProperty('prompt');
    expect(response.item.openings[0]).not.toHaveProperty('component');
    expect(response).not.toHaveProperty('warnings');
    services.worlds.update(world.id, { presentation: { type: 'markdown', text: 'A public introduction' } });
    const plain = await data<{ item: WorldDetail }>(await app.request(base + '/' + world.id));
    expect(plain.item.presentation).toEqual({ type: 'markdown', text: 'A public introduction' });
    expect(plain.item).not.toHaveProperty('description');
    const cleared = await data<{ item: WorldDetail }>(await jsonRequest('/' + world.id, 'PATCH', { expectedRevision: 2, defaultPresetId: null, defaultApiModelConfigId: null }));
    expect(cleared.item.defaultPresetId).toBeNull();
    expect(cleared.item.defaultApiModelConfigId).toBeNull();
  });

  it('exposes and saves a reply-assist default without changing existing sessions', async () => {
    const { presetId, apiModelConfigId } = configuration();
    const reply = services.presets.create({ ...services.presets.getDefault('reply_assist'), name: 'World reply' });
    const world = services.worlds.create(content());
    const session = services.sessions.create({ worldId: world.id, userCharacterId: 'player', runtimeConfig: {
      narrativePresetId: presetId, apiModelConfigId, replyAssistPresetId: null,
    } });
    const fetched = await data<{ item: WorldDetail }>(await app.request(base + '/' + world.id));
    expect(fetched.item.defaultReplyAssistPresetId).toBeNull();
    await failure(await jsonRequest('/' + world.id, 'PATCH', { defaultReplyAssistPresetId: presetId }), 'PRESET_TYPE_MISMATCH', 400);
    await failure(await jsonRequest('/' + world.id, 'PATCH', { defaultReplyAssistPresetId: 'missing' }), 'PRESET_NOT_FOUND', 404);
    const saved = await data<{ item: WorldDetail }>(await jsonRequest('/' + world.id, 'PATCH', { defaultReplyAssistPresetId: reply.id }));
    expect(saved.item).toMatchObject({ defaultReplyAssistPresetId: reply.id, revision: 2 });
    const reloaded = await data<{ item: WorldDetail }>(await app.request(base + '/' + world.id));
    expect(reloaded.item.defaultReplyAssistPresetId).toBe(reply.id);
    expect(services.sessions.require(session.id).runtimeConfig.replyAssistPresetId).toBeNull();
    await failure(await jsonRequest('/' + world.id, 'PATCH', { defaultReplyAssistPresetId: null }), 'WORLD_REVISION_CONFLICT', 409);
    const cleared = await data<{ item: WorldDetail }>(await jsonRequest('/' + world.id, 'PATCH', { defaultReplyAssistPresetId: null, expectedRevision: 2 }));
    expect(cleared.item.defaultReplyAssistPresetId).toBeNull();
  });

  it('reports invalid management input and references without partial writes', async () => {
    const world = services.worlds.create({ ...content(), tags: ['keep'] });
    await failure(await jsonRequest('/' + world.id, 'PATCH', { defaultPresetId: 'missing' }), 'PRESET_NOT_FOUND', 404);
    await failure(await jsonRequest('/' + world.id, 'PATCH', { defaultApiModelConfigId: 'missing' }), 'MODEL_CONFIG_NOT_FOUND', 404);
    for (const body of [{}, { state: {} }, { wrong: [] }, { tags: ['lost'], extra: [] }, { tags: null }, { tags: 'lost' }, { description: {} }]) {
      await failure(await jsonRequest('/' + world.id, 'PATCH', body), 'INVALID_REQUEST', 400);
      expect(services.worlds.get(world.id)?.tags).toEqual(['keep']);
    }
    await failure(await app.request(base + '?limit=abc'), 'INVALID_REQUEST', 400);
    await failure(await app.request(base + '?limit=0'), 'INVALID_WORLD_PAGINATION', 400);
    await failure(await app.request(base + '/%2e%2e%2foutside', { method: 'DELETE' }), 'INVALID_WORLD_ID', 400);
  });

  it('deletes a worlds source and package without affecting another world', async () => {
    const world = services.worlds.create(content());
    const other = services.worlds.create({ ...content(), id: 'world-two' });
    const paths = await resources(world.id);
    const otherPaths = await resources(other.id);
    expect(await data(await app.request(base + '/' + world.id, { method: 'DELETE' }))).toEqual({ id: world.id });
    expect(services.worlds.get(world.id)).toBeNull();
    await expect(readdir(paths.root)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(otherPaths.source, 'original.json'), 'utf8')).toBe('original-world-two');
    expect(await readFile(join(otherPaths.package, 'resource.txt'), 'utf8')).toBe('package-world-two');
  });

  it('requires explicit confirmation and preserves sessions, messages and files before it', async () => {
    const world = services.worlds.create({ ...content(), tags: ['bound'] });
    const paths = await resources(world.id);
    const { session, entry } = sessionWithEntry(world.id, 'linked', configuration());
    const response = await app.request(base + '/' + world.id, { method: 'DELETE' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      success: false, errorCode: 'WORLD_HAS_SESSIONS', data: null,
      errorMessage: expect.stringContaining('1 个会话'),
    });
    await failure(await app.request(base + '/' + world.id + '?deleteSessions=false', { method: 'DELETE' }), 'WORLD_HAS_SESSIONS', 409);
    expect(services.sessions.get(session.id)).not.toBeNull();
    expect(services.sessions.getEntry(session.id, entry.id)).not.toBeNull();
    expect(services.worlds.require(world.id).tags).toEqual(['bound']);
    expect(await readFile(join(paths.source, 'original.json'), 'utf8')).toBe('original-world-one');
    expect(await readFile(join(paths.package, 'resource.txt'), 'utf8')).toBe('package-world-one');
  });

  it('deletes every confirmed session and message beyond a list page while preserving another world', async () => {
    const world = services.worlds.create({ ...content(), tags: ['bound'] });
    const other = services.worlds.create({ ...content(), id: 'world-two', tags: ['keep'] });
    const paths = await resources(world.id);
    const otherPaths = await resources(other.id);
    const config = configuration();
    const linked = Array.from({ length: 25 }, (_, index) => sessionWithEntry(world.id, 'linked-' + index, config));
    const retained = sessionWithEntry(other.id, 'retained', config);
    expect(await data(await app.request(base + '/' + world.id + '?deleteSessions=true', { method: 'DELETE' }))).toEqual({ id: world.id });
    expect(services.worlds.get(world.id)).toBeNull();
    for (const { session, entry } of linked) {
      expect(services.sessions.get(session.id)).toBeNull();
      expect(services.sessions.getEntry(session.id, entry.id)).toBeNull();
    }
    expect(services.worlds.require(other.id).tags).toEqual(['keep']);
    expect(services.sessions.get(retained.session.id)).not.toBeNull();
    expect(services.sessions.getEntry(retained.session.id, retained.entry.id)).not.toBeNull();
    expect(services.presets.get(config.presetId)).not.toBeNull();
    expect(services.models.get(config.apiModelConfigId)).not.toBeNull();
    await expect(readdir(paths.root)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(otherPaths.package, 'resource.txt'), 'utf8')).toBe('package-world-two');
  });

  it('rolls back earlier session deletions when a later session has an active run', async () => {
    const world = services.worlds.create({ ...content(), tags: ['bound'] });
    const paths = await resources(world.id);
    const config = configuration();
    const linked = ['a-idle', 'z-running'].map(id => sessionWithEntry(world.id, id, config));
    const permit = services.cache.acquireRun({ sessionId: 'z-running', worldId: world.id, runId: 'running' });
    await failure(await app.request(base + '/' + world.id + '?deleteSessions=true', { method: 'DELETE' }), 'SESSION_WRITE_LOCKED', 409);
    for (const { session, entry } of linked) {
      expect(services.sessions.get(session.id)).not.toBeNull();
      expect(services.sessions.getEntry(session.id, entry.id)).not.toBeNull();
    }
    expect(services.worlds.require(world.id).tags).toEqual(['bound']);
    expect(await readFile(join(paths.package, 'resource.txt'), 'utf8')).toBe('package-world-one');
    services.cache.releaseRun(permit);
    expect(await data(await app.request(base + '/' + world.id + '?deleteSessions=true', { method: 'DELETE' }))).toEqual({ id: world.id });
  });

  it('rolls back all session deletions if deleting the world record fails', async () => {
    const world = services.worlds.create(content());
    const paths = await resources(world.id);
    const { session, entry } = sessionWithEntry(world.id, 'linked', configuration());
    vi.spyOn(services.worlds, 'deleteRecord').mockImplementationOnce(() => { throw new Error('simulated write failure'); });
    await failure(await app.request(base + '/' + world.id + '?deleteSessions=true', { method: 'DELETE' }), 'INTERNAL_ERROR', 500);
    expect(services.worlds.get(world.id)).not.toBeNull();
    expect(services.sessions.get(session.id)).not.toBeNull();
    expect(services.sessions.getEntry(session.id, entry.id)).not.toBeNull();
    expect(await readFile(join(paths.package, 'resource.txt'), 'utf8')).toBe('package-world-one');
  });

  it('rejects malformed confirmation flags without deleting any data', async () => {
    const world = services.worlds.create(content());
    sessionWithEntry(world.id, 'linked', configuration());
    for (const value of ['1', '0', '', 'TRUE', 'yes']) {
      await failure(await app.request(base + '/' + world.id + '?deleteSessions=' + value, { method: 'DELETE' }), 'INVALID_REQUEST', 400);
    }
    expect(services.worlds.get(world.id)).not.toBeNull();
    expect(services.sessions.get('linked')).not.toBeNull();
  });

  it('requires access to every session before a confirmed world deletion', async () => {
    const world = services.worlds.create(content());
    const paths = await resources(world.id);
    const config = configuration();
    const linked = ['a-allowed', 'z-denied'].map(id => sessionWithEntry(world.id, id, config));
    const access = vi.fn(async (id: string) => id !== 'z-denied');
    const guarded = new Hono().onError(errorHandler).route(base, worldRoutes(access));
    await failure(await guarded.request(base + '/' + world.id + '?deleteSessions=true', { method: 'DELETE' }), 'SESSION_NOT_FOUND', 404);
    expect(access.mock.calls.map(([id]) => id)).toEqual(['a-allowed', 'z-denied']);
    for (const { session, entry } of linked) {
      expect(services.sessions.get(session.id)).not.toBeNull();
      expect(services.sessions.getEntry(session.id, entry.id)).not.toBeNull();
    }
    expect(services.worlds.get(world.id)).not.toBeNull();
    expect(await readFile(join(paths.package, 'resource.txt'), 'utf8')).toBe('package-world-one');
  });

  it('refuses an unchecked session created while access authorization was awaiting', async () => {
    const world = services.worlds.create(content());
    const config = configuration();
    sessionWithEntry(world.id, 'old', config);
    const access = vi.fn(async () => {
      await Promise.resolve();
      sessionWithEntry(world.id, 'new', config);
      return true;
    });
    const guarded = new Hono().onError(errorHandler).route(base, worldRoutes(access));
    await failure(await guarded.request(base + '/' + world.id + '?deleteSessions=true', { method: 'DELETE' }), 'WORLD_HAS_SESSIONS', 409);
    expect(services.worlds.get(world.id)).not.toBeNull();
    expect(services.sessions.listIdsByWorld(world.id)).toEqual(['new', 'old']);
    expect(services.sessions.getEntry('old', 'old-entry')).not.toBeNull();
    expect(services.sessions.getEntry('new', 'new-entry')).not.toBeNull();
  });

  it('retries file cleanup after the database row was deleted on the first attempt', async () => {
    const world = services.worlds.create(content());
    const paths = await resources(world.id);
    const { session, entry } = sessionWithEntry(world.id, 'linked', configuration());
    vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error('simulated cleanup failure'), { code: 'EACCES' }));
    await failure(await app.request(base + '/' + world.id + '?deleteSessions=true', { method: 'DELETE' }), 'WORLD_FILES_DELETE_FAILED', 500);
    expect(services.worlds.get(world.id)).toBeNull();
    expect(services.sessions.get(session.id)).toBeNull();
    expect(services.sessions.getEntry(session.id, entry.id)).toBeNull();
    expect(await readFile(join(paths.source, 'original.json'), 'utf8')).toBe('original-world-one');
    expect(await data(await app.request(base + '/' + world.id, { method: 'DELETE' }))).toEqual({ id: world.id });
    await expect(readdir(paths.root)).rejects.toMatchObject({ code: 'ENOENT' });
    await failure(await app.request(base + '/' + world.id, { method: 'DELETE' }), 'WORLD_NOT_FOUND', 404);
  });

  it('imports multipart JSON and exports the current card as ZIP with a safe Unicode filename', async () => {
    const fixture = worldCardFixture();
    const sprites = [{ id: 'default', asset: 'https://images.example/player.webp', description: '平静' }];
    const original = JSON.stringify({ ...fixture, data: { ...fixture.data, characters: [{ ...fixture.data.characters[0], sprites }] } });
    const form = new FormData();
    form.set('file', new File([original], 'old-upload.json', { type: 'application/json' }));
    const imported = await data<{ item: WorldDetail }>(
      await app.request(base + '/import', { method: 'POST', body: form }), 201);
    expect(imported).not.toHaveProperty('warnings');
    expect(imported.item.name).toBe('雾港');
    expect(imported.item).not.toHaveProperty('spec');
    await jsonRequest('/' + imported.item.id, 'PATCH', { name: '新 名称', tags: ['现在'] });
    const response = await app.request(base + '/' + imported.item.id + '/export');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/zip');
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="world.zip"; filename*=UTF-8\'\'' + encodeURIComponent('新 名称.zip'));
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const exported = await unzipBytes(new Uint8Array(await response.arrayBuffer()));
    const card = JSON.parse(exported['world.json']!.toString());
    expect(card).toMatchObject({ spec_version: '0.2', data: { name: '新 名称', tags: ['现在'] } });
    expect(card).not.toHaveProperty('spec');
    expect(card.data.characters[0].sprites).toEqual(sprites);
    const source = await app.request(base + '/' + imported.item.id + '/original');
    expect(await source.text()).toBe(original);
    await vi.waitFor(async () => expect(await readdir(join(root, 'staging'))).toEqual([]));

    const head = await app.request(base + '/' + imported.item.id + '/export', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(Number(head.headers.get('Content-Length'))).toBeGreaterThan(0);
    expect(await head.text()).toBe('');
    await vi.waitFor(async () => expect(await readdir(join(root, 'staging'))).toEqual([]));
    await failure(await app.request(base + '/missing/export'), 'WORLD_NOT_FOUND', 404);
  });

  it('imports ZIP resources through multipart', async () => {
    const bytes = await zipBytes([
      { name: 'world.json', data: JSON.stringify(worldCardFixture()) },
      { name: 'assets/asset.txt', data: 'resource' },
    ]);
    const form = new FormData();
    form.set('file', new File([new Uint8Array(bytes)], 'different-upload.zip'));
    const { item } = await data<{ item: WorldDetail }>(await app.request(base + '/import', { method: 'POST', body: form }), 201);
    expect(await (await app.request(base + '/' + item.id + '/resources/assets/asset.txt')).text()).toBe('resource');
  });

  it('rejects invalid multipart and oversized files with the ordinary error envelope', async () => {
    await failure(await app.request(base + '/import', { method: 'POST', body: '{}' }), 'INVALID_REQUEST', 400);
    for (const [name, bytes, code, status] of [
      ['card.json', '{broken', 'INVALID_WORLD_CARD', 422],
      ['card.txt', '{}', 'INVALID_WORLD_ORIGINAL_FORMAT', 400],
      ['card.json', 'x'.repeat(1025), 'PAYLOAD_TOO_LARGE', 413],
    ] as const) {
      const form = new FormData();
      form.set('file', new File([bytes], name));
      await failure(await app.request(base + '/import', { method: 'POST', body: form }), code, status);
    }
    expect(services.worlds.list()).toEqual([]);
  });

  it('bounds actual multipart bytes before parsing even without or with a false Content-Length', async () => {
    const importSpy = vi.fn(createImportWorld({ worlds: services.worlds, settings: services.settings }));
    const bounded = new Hono().onError(errorHandler).route(base, worldRoutes(undefined, importSpy));
    const variants: Record<string, string>[] = [{}, { 'content-length': '1' }, { 'transfer-encoding': 'chunked' }];
    for (const extra of variants) {
      const cancel = vi.fn();
      const chunk = new Uint8Array(600000);
      const body = new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(chunk); },
        cancel,
      });
      const init: RequestInit & { duplex: 'half' } = {
        method: 'POST', body, duplex: 'half',
        headers: { 'content-type': 'multipart/form-data; boundary=test', ...extra },
      };
      const request = new Request('http://localhost' + base + '/import', init);
      await failure(await bounded.request(request), 'PAYLOAD_TOO_LARGE', 413);
      await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
    }
    expect(importSpy).not.toHaveBeenCalled();
    expect(services.worlds.list()).toEqual([]);
  });

  it('downloads preserved JSON and ZIP originals as exact bytes with fixed original names', async () => {
    for (const format of ['json', 'zip'] as const) {
      const world = services.worlds.create({ ...content(), id: 'source-' + format, name: '当前世界名称' });
      const bytes = format === 'json' ? Buffer.from('{"old":"original"}\n') : Buffer.from([80, 75, 3, 4, 0, 255]);
      await services.worlds.saveOriginal(world.id, format, bytes);
      const response = await app.request(base + '/' + world.id + '/original');
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe(format === 'json' ? 'application/json' : 'application/zip');
      expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="original.' + format + '"');
      expect(response.headers.get('Content-Length')).toBe(String(bytes.byteLength));
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    }
    const withoutOriginal = services.worlds.create({ ...content(), id: 'no-source' });
    await failure(await app.request(base + '/' + withoutOriginal.id + '/original'), 'WORLD_ORIGINAL_NOT_FOUND', 404);
    await failure(await app.request(base + '/missing/original'), 'WORLD_NOT_FOUND', 404);
  });

  it('streams nested package resources with MIME headers and rejects unsafe or missing paths', async () => {
    const world = services.worlds.create(content());
    await failure(await app.request(base + '/' + world.id + '/resources/assets/absent.png'), 'WORLD_PACKAGE_FILE_NOT_FOUND', 404);
    const directory = services.worlds.paths(world.id).package;
    await mkdir(join(directory, 'assets'), { recursive: true });
    const media = Buffer.alloc(192 * 1024, 58);
    await writeFile(join(directory, 'assets', 'scene.mp4'), media);
    const response = await app.request(base + '/' + world.id + '/resources/assets/scene.mp4');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('video/mp4');
    expect(response.headers.get('Content-Disposition')).toBeNull();
    expect(response.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(media);
    const head = await app.request(base + '/' + world.id + '/resources/assets/scene.mp4', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Length')).toBe(String(media.byteLength));
    expect(await head.text()).toBe('');
    await failure(await app.request(base + '/' + world.id + '/resources/%2e%2e%2fsource%2foriginal.json'), 'INVALID_WORLD_PACKAGE_PATH', 400);
    await failure(await app.request(base + '/' + world.id + '/resources/assets%5csecret'), 'INVALID_WORLD_PACKAGE_PATH', 400);
    await failure(await app.request(base + '/' + world.id + '/resources/assets/absent.png'), 'WORLD_PACKAGE_FILE_NOT_FOUND', 404);
    await writeFile(join(root, 'outside.txt'), 'outside');
    await symlink(join(root, 'outside.txt'), join(directory, 'assets', 'link.txt'));
    await failure(await app.request(base + '/' + world.id + '/resources/assets/link.txt'), 'INVALID_WORLD_PACKAGE_FILE', 400);
    await failure(await app.request(base + '/missing/resources/assets/scene.mp4'), 'WORLD_NOT_FOUND', 404);
  });
});
