import { Hono } from 'hono';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../database/connection.js';
import { errorHandler, type SuccessResponse } from '../http/response.js';
import { createServices } from '../services.js';
import { narrativePreset } from '../testing/fixtures.js';
import type { WorldRecord } from '../worlds/service.js';
import { createWorldRoutes } from './worlds.js';

let db: DatabaseSync;
let root: string;
let services: ReturnType<typeof createServices>;
let app: Hono;
const base = '/api/v1/worlds';
const content = () => ({ id: 'world-one', name: '雾港', spec_version: '0.1', characters_json: [], openings_json: [] });

beforeEach(async () => {
  db = openDatabase(':memory:');
  root = await mkdtemp(join(tmpdir(), 'sr-v2-world-routes-'));
  services = createServices(db, root);
  app = new Hono().onError(errorHandler).route(base, createWorldRoutes(services.worlds));
});
afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
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

describe('world routes', () => {
  it('creates, reads, updates, filters and deletes worlds with the common JSON envelope', async () => {
    const { item } = await data<{ item: WorldRecord }>(await jsonRequest('', 'POST', {
      ...content(), state: { coins: 1 }, tags: [' 城市 ', '城市'],
    }), 201);
    expect(item.tags).toEqual(['城市']);
    expect((await data<{ item: WorldRecord }>(await app.request(base + '/' + item.id))).item.name).toBe('雾港');
    services.state.setGlobal(item.id, { coins: 9 });
    const updated = await data<{ item: WorldRecord }>(await jsonRequest('/' + item.id, 'PATCH', { name: '新雾港' }));
    expect(updated.item).toMatchObject({ name: '新雾港', state: { coins: 9 } });
    const tagged = await data<{ item: WorldRecord }>(await jsonRequest('/' + item.id + '/tags', 'PUT', { tags: ['港口', ' 城市 ', '港口'] }));
    expect(tagged.item.tags).toEqual(['港口', '城市']);
    const catalog = await data<{ items: { name: string; world_count: number }[] }>(await app.request(base + '/tags'));
    expect(catalog.items).toEqual([{ name: '城市', world_count: 1 }, { name: '港口', world_count: 1 }]);
    const list = await data<{ items: WorldRecord[] }>(await app.request(base + '?tag=' + encodeURIComponent('港口') + '&limit=1&offset=0'));
    expect(list.items.map(world => world.id)).toEqual([item.id]);
    expect(await data(await app.request(base + '/' + item.id, { method: 'DELETE' }))).toEqual({ id: item.id });
    await failure(await app.request(base + '/' + item.id), 'WORLD_NOT_FOUND', 404);
    await failure(await app.request(base + '/' + item.id, { method: 'DELETE' }), 'WORLD_NOT_FOUND', 404);
    await failure(await jsonRequest('/' + item.id, 'PATCH', { name: 'missing' }), 'WORLD_NOT_FOUND', 404);
    await failure(await jsonRequest('/' + item.id + '/tags', 'PUT', { tags: [] }), 'WORLD_NOT_FOUND', 404);
  });

  it('reports invalid input and reference failures without partial writes', async () => {
    await failure(await jsonRequest('', 'POST', { ...content(), default_preset_id: 'missing' }), 'PRESET_NOT_FOUND', 404);
    await failure(await jsonRequest('', 'POST', { ...content(), default_api_model_config_id: 'missing' }), 'MODEL_CONFIG_NOT_FOUND', 404);
    expect(services.worlds.list()).toEqual([]);
    const world = services.worlds.create({ ...content(), tags: ['keep'] });
    await failure(await jsonRequest('/' + world.id, 'PATCH', { state: {} }), 'INVALID_WORLD_FIELD', 400);
    for (const body of [{}, { wrong: [] }, { tags: ['lost'], extra: [] }, { tags: null }, { tags: 'lost' }]) {
      await failure(await jsonRequest('/' + world.id + '/tags', 'PUT', body), 'INVALID_WORLD_TAGS', 400);
      expect(services.worlds.get(world.id)?.tags).toEqual(['keep']);
    }
    await failure(await app.request(base + '?limit=abc'), 'INVALID_REQUEST', 400);
    await failure(await app.request(base + '?limit=0'), 'INVALID_WORLD_PAGINATION', 400);
    const preset = services.presets.create(narrativePreset());
    const model = services.models.create({ name: 'model', provider_id: 'test', model_id: 'test', credential_ref: 'test' });
    services.sessions.create({
      world_id: world.id, preset_id: preset.id, api_model_config_id: model.id, user_character_id: 'player',
    });
    await failure(await app.request(base + '/' + world.id, { method: 'DELETE' }), 'REFERENCE_CONFLICT', 409);
    expect(services.worlds.get(world.id)?.name).toBe(world.name);
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
