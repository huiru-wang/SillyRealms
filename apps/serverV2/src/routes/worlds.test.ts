import { Hono } from 'hono';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../database/connection.js';
import type { Page } from '../http/pagination.js';
import { errorHandler, type SuccessResponse } from '../http/response.js';
import { createServices } from '../services.js';
import { narrativePreset } from '../testing/fixtures.js';
import { createTagRoutes, createWorldRoutes } from './worlds.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

type WorldDetail = {
  id: string; specVersion: string; data: Record<string, unknown>;
  defaultPresetId: string | null; defaultApiModelConfigId: string | null;
};
type WorldListItem = { id: string; name: string; cover: string | null; tags: { id: string; name: string }[]; sessionCount: number };
let db: DatabaseSync;
let root: string;
let services: ReturnType<typeof createServices>;
let app: Hono;
const base = '/api/v1/worlds';
const content = () => ({ id: 'world-one', name: '雾港', specVersion: '0.1', characters: [], openings: [] });

beforeEach(async () => {
  db = openDatabase(':memory:');
  root = await mkdtemp(join(tmpdir(), 'sr-v2-world-routes-'));
  services = createServices(db, root);
  app = new Hono().onError(errorHandler)
    .route(base, createWorldRoutes({ worlds: services.worlds, sessions: services.sessions }))
    .route('/api/v1/tags', createTagRoutes(services.worlds));
});
afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

function jsonRequest(path: string, method: string, body: unknown) {
  return app.request(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
  it('creates, reads, updates and deletes Studio world details with the common JSON envelope', async () => {
    const { item } = await data<{ item: WorldDetail }>(await jsonRequest('', 'POST', {
      ...content(), state: { coins: 1 }, tags: [' 城市 ', '城市'],
    }), 201);
    expect(item.data.tags).toEqual(['城市']);
    expect((await data<{ item: WorldDetail }>(await app.request(base + '/' + item.id))).item.data.name).toBe('雾港');
    services.state.setGlobal(item.id, { coins: 9 });
    const updated = await data<{ item: WorldDetail }>(await jsonRequest('/' + item.id, 'PATCH', { name: '新雾港' }));
    expect(updated.item.data.name).toBe('新雾港');
    expect(updated.item.data).not.toHaveProperty('state');
    expect(services.worlds.require(item.id).state).toEqual({ coins: 9 });
    const tagged = await data<{ item: WorldDetail }>(await jsonRequest('/' + item.id + '/tags', 'PUT', { tags: ['港口', ' 城市 ', '港口'] }));
    expect(tagged.item.data.tags).toEqual(['港口', '城市']);
    const catalog = await data<{ items: { id: string; name: string }[] }>(await app.request(base + '/tags'));
    expect(catalog.items).toEqual([{ id: '城市', name: '城市' }, { id: '港口', name: '港口' }]);
    expect(await data(await app.request(base + '/' + item.id, { method: 'DELETE' }))).toEqual({ id: item.id });
    await failure(await app.request(base + '/' + item.id), 'WORLD_NOT_FOUND', 404);
    await failure(await app.request(base + '/' + item.id, { method: 'DELETE' }), 'WORLD_NOT_FOUND', 404);
    await failure(await jsonRequest('/' + item.id, 'PATCH', { name: 'missing' }), 'WORLD_NOT_FOUND', 404);
    await failure(await jsonRequest('/' + item.id + '/tags', 'PUT', { tags: [] }), 'WORLD_NOT_FOUND', 404);
  });

  it('returns filtered cursor pages, tag IDs and real session counts for Studio', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const first = services.worlds.create({ ...content(), id: 'world-c', tags: ['城市'], cover: 'assets/cover.png' });
    const second = services.worlds.create({ ...content(), id: 'world-a', tags: ['城市'] });
    services.worlds.create({ ...content(), id: 'world-b', tags: ['荒野'] });
    const config = configuration();
    for (const id of ['session-one', 'session-two']) {
      services.sessions.create({ ...config, id, worldId: first.id, userCharacterId: 'player' });
    }
    const url = base + '?tagId=' + encodeURIComponent('城市') + '&limit=1';
    const firstPage = await data<Page<WorldListItem>>(await app.request(url));
    expect(firstPage.items).toEqual([{
      id: first.id, name: first.name, cover: 'assets/cover.png',
      tags: [{ id: '城市', name: '城市' }], sessionCount: 2,
    }]);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const lastPage = await data<Page<WorldListItem>>(await app.request(url + '&cursor=' + firstPage.nextCursor));
    expect(lastPage).toEqual({
      items: [{ id: second.id, name: second.name, cover: null, tags: [{ id: '城市', name: '城市' }], sessionCount: 0 }],
      hasMore: false, nextCursor: null,
    });
    expect(await data(await app.request(base + '?tagId=absent'))).toEqual({ items: [], hasMore: false, nextCursor: null });
    await failure(await app.request(base + '?tagId=other&cursor=' + firstPage.nextCursor), 'INVALID_REQUEST', 400);
    await failure(await app.request(base + '?cursor=invalid'), 'INVALID_REQUEST', 400);
    expect(await data(await app.request('/api/v1/tags?type=world'))).toEqual({
      items: [{ id: '城市', name: '城市' }, { id: '荒野', name: '荒野' }],
    });
    await failure(await app.request('/api/v1/tags?type=preset'), 'INVALID_REQUEST', 400);
  });

  it('projects author document fields and component descriptions without exposing runtime state', async () => {
    const { presetId, apiModelConfigId } = configuration();
    const description = { type: 'component' as const, component: 'intro' };
    const definition = { schema_version: 2, scopes: { global: { coins: { type: 'number' } } } };
    const world = services.worlds.create({
      ...content(), description, stateDefinition: definition, state: { coins: 7 },
      defaultPresetId: presetId, defaultApiModelConfigId: apiModelConfigId,
      characters: [{ id: 'player', player_selectable: true }],
      openings: [{ id: 'start', initial_state: { author_key: 1 } }],
      components: [{ id: 'intro', path: 'intro.tsx' }], stageComponent: 'stage',
      messageRender: { author_key: 'message' }, extensions: { custom_key: 1 },
    });
    const response = await data<{ item: WorldDetail; warnings: unknown[] }>(await app.request(base + '/' + world.id));
    expect(response).toMatchObject({
      warnings: [], item: {
        id: world.id, specVersion: '0.1', defaultPresetId: presetId, defaultApiModelConfigId: apiModelConfigId,
        data: {
          description, state: definition, stage_component: 'stage', message_render: { author_key: 'message' },
          characters: [{ id: 'player', player_selectable: true }],
          openings: [{ id: 'start', initial_state: { author_key: 1 } }],
          extensions: { custom_key: 1 },
        },
      },
    });
    expect(response.item).not.toHaveProperty('state');
    expect(response.item).not.toHaveProperty('characters_json');
    services.worlds.update(world.id, { description: 'A plain textual description' });
    const plain = await data<{ item: WorldDetail }>(await app.request(base + '/' + world.id));
    expect(plain.item.data).not.toHaveProperty('description');
    expect(services.worlds.require(world.id).description).toBe('A plain textual description');
    const cleared = await data<{ item: WorldDetail }>(await jsonRequest('/' + world.id, 'PATCH', {
      defaultPresetId: null, defaultApiModelConfigId: null,
    }));
    expect(cleared.item.defaultPresetId).toBeNull();
    expect(cleared.item.defaultApiModelConfigId).toBeNull();
  });

  it('reports invalid input and reference failures without partial writes', async () => {
    await failure(await jsonRequest('', 'POST', { ...content(), defaultPresetId: 'missing' }), 'PRESET_NOT_FOUND', 404);
    await failure(await jsonRequest('', 'POST', { ...content(), defaultApiModelConfigId: 'missing' }), 'MODEL_CONFIG_NOT_FOUND', 404);
    expect(services.worlds.list()).toEqual([]);
    const world = services.worlds.create({ ...content(), tags: ['keep'] });
    await failure(await jsonRequest('/' + world.id, 'PATCH', { state: {} }), 'INVALID_WORLD_FIELD', 400);
    for (const body of [{}, { wrong: [] }, { tags: ['lost'], extra: [] }, { tags: null }, { tags: 'lost' }]) {
      await failure(await jsonRequest('/' + world.id + '/tags', 'PUT', body), 'INVALID_WORLD_TAGS', 400);
      expect(services.worlds.get(world.id)?.tags).toEqual(['keep']);
    }
    await failure(await jsonRequest('/' + world.id, 'PATCH', { description: { type: 'component', component: '' } }), 'INVALID_WORLD_FIELD', 400);
    await failure(await app.request(base + '?limit=abc'), 'INVALID_REQUEST', 400);
    await failure(await app.request(base + '?limit=0'), 'INVALID_REQUEST', 400);
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

  it('preserves files when a session prevents the database deletion', async () => {
    const world = services.worlds.create({ ...content(), tags: ['bound'] });
    const paths = await resources(world.id);
    services.sessions.create({ ...configuration(), worldId: world.id, userCharacterId: 'player' });
    await failure(await app.request(base + '/' + world.id, { method: 'DELETE' }), 'REFERENCE_CONFLICT', 409);
    expect(services.worlds.require(world.id).tags).toEqual(['bound']);
    expect(await readFile(join(paths.source, 'original.json'), 'utf8')).toBe('original-world-one');
    expect(await readFile(join(paths.package, 'resource.txt'), 'utf8')).toBe('package-world-one');
  });

  it('retries file cleanup after the database row was deleted on the first attempt', async () => {
    const world = services.worlds.create(content());
    const paths = await resources(world.id);
    vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error('simulated cleanup failure'), { code: 'EACCES' }));
    await failure(await app.request(base + '/' + world.id, { method: 'DELETE' }), 'WORLD_FILES_DELETE_FAILED', 500);
    expect(services.worlds.get(world.id)).toBeNull();
    expect(await readFile(join(paths.source, 'original.json'), 'utf8')).toBe('original-world-one');
    expect(await data(await app.request(base + '/' + world.id, { method: 'DELETE' }))).toEqual({ id: world.id });
    await expect(readdir(paths.root)).rejects.toMatchObject({ code: 'ENOENT' });
    await failure(await app.request(base + '/' + world.id, { method: 'DELETE' }), 'WORLD_NOT_FOUND', 404);
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
    await failure(await app.request(base + '/' + world.id + '/package/assets/absent.png'), 'WORLD_PACKAGE_FILE_NOT_FOUND', 404);
    const directory = services.worlds.paths(world.id).package;
    await mkdir(join(directory, 'assets'), { recursive: true });
    const media = Buffer.alloc(192 * 1024, 58);
    await writeFile(join(directory, 'assets', 'scene.mp4'), media);
    const response = await app.request(base + '/' + world.id + '/package/assets/scene.mp4');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('video/mp4');
    expect(response.headers.get('Content-Disposition')).toBeNull();
    expect(response.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(media);
    const head = await app.request(base + '/' + world.id + '/package/assets/scene.mp4', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('Content-Length')).toBe(String(media.byteLength));
    expect(await head.text()).toBe('');
    await failure(await app.request(base + '/' + world.id + '/package/%2e%2e%2fsource%2foriginal.json'), 'INVALID_WORLD_PACKAGE_PATH', 400);
    await failure(await app.request(base + '/' + world.id + '/package/assets%5csecret'), 'INVALID_WORLD_PACKAGE_PATH', 400);
    await failure(await app.request(base + '/' + world.id + '/package/assets/absent.png'), 'WORLD_PACKAGE_FILE_NOT_FOUND', 404);
    await writeFile(join(root, 'outside.txt'), 'outside');
    await symlink(join(root, 'outside.txt'), join(directory, 'assets', 'link.txt'));
    await failure(await app.request(base + '/' + world.id + '/package/assets/link.txt'), 'INVALID_WORLD_PACKAGE_FILE', 400);
    await failure(await app.request(base + '/missing/package/assets/scene.mp4'), 'WORLD_NOT_FOUND', 404);
  });
});
