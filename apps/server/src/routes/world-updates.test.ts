import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../errors.js';
import { openDatabase } from '../infrastructure/database/connection.js';
import { EventHub } from '../infrastructure/events/event-hub.js';
import { errorHandler, type SuccessResponse } from '../http/response.js';
import type { World, WorldImportInput } from '../modules/worlds/service.js';
import { worldCardFixture, zipBytes } from '../modules/worlds/test-fixtures.js';
import { createServices } from '../services.js';
import { createExportWorld } from '../usecases/export-world.js';
import { createDeleteWorld } from '../usecases/delete-world.js';
import { bindTransaction } from '../infrastructure/database/transaction.js';
import { createImportWorld } from '../usecases/import-world.js';
import {
  createWorldUpdates, type WorldUpdates, type WorldReleaseRecord, type WorldVersions,
} from '../usecases/world-updates/index.js';
import { createWorldRoutes } from './worlds.js';

const base = '/api/v1/worlds';
const packageId = '76e9723c-ab6e-4b59-a384-6f34f1b0b4a1';
const updateUrl = 'https://publisher.example/releases.json';
const publishedAt = '2026-11-26T00:00:00Z';
const publication = (version: string) => ({
  package_id: packageId, authors: [{ name: '作者', url: 'https://publisher.example/' }],
  creator_notes: '作者说明', release: { version, published_at: publishedAt, notes: 'Release ' + version },
  update_url: updateUrl,
});
function card(version: string) {
  const value = worldCardFixture();
  return { ...value, spec_version: '0.2', data: { ...value.data, publication: publication(version),
    cover: 'sr-asset://assets/scene.txt',
    characters: value.data.characters.map(character => ({ ...character, content: 'Prompt ' + version })),
  } };
}
let db: DatabaseSync, root: string, services: ReturnType<typeof createServices>;
let app: Hono, updates: WorldUpdates, world: World;
let artifacts: Map<string, WorldImportInput>;
const downloads = {
  getIndex: vi.fn<(url: string, signal: AbortSignal) => Promise<string>>(),
  getArtifact: vi.fn<(release: WorldReleaseRecord, signal: AbortSignal) => Promise<WorldImportInput>>(),
};
function record(version: string): WorldReleaseRecord {
  const input = artifacts.get(version)!;
  return { version, title: 'Title ' + version, published_at: publishedAt, notes: 'Release ' + version, spec_version: '0.2',
    artifact: { format: 'zip', url: 'https://cdn.example/' + version + '.zip',
      sha256: createHash('sha256').update(input.bytes).digest('hex'), size_bytes: input.bytes.length } };
}
function indexText() {
  return JSON.stringify({ schema_version: 1, package_id: packageId, versions: ['1.0.0', '2.0.0'].map(record) });
}
async function data<T>(response: Response): Promise<T> {
  expect(response.status).toBe(200);
  const body = await response.json() as SuccessResponse<T>;
  expect(body).toMatchObject({ success: true, errorCode: null, errorMessage: '' });
  return body.data;
}
function post(path: string, body?: unknown) {
  return app.request(base + '/' + world.id + path, { method: 'POST',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
}
const applyBody = (version = '2.0.0') => ({
  version, expectedSha256: record(version).artifact.sha256, expectedRevision: world.revision,
});

beforeEach(async () => {
  db = openDatabase(':memory:');
  root = await mkdtemp(join(tmpdir(), 'sr-world-update-routes-'));
  services = createServices(db, root);
  services.settings.ensure({ defaultPresetId: null, defaultApiModelConfigId: null });
  artifacts = new Map(await Promise.all(['1.0.0', '2.0.0'].map(async version => [version, {
    format: 'zip' as const, bytes: await zipBytes([
      { name: 'world.json', data: JSON.stringify(card(version)) },
      { name: 'assets/scene.txt', data: 'scene from ' + version },
    ]),
  }] as const)));
  downloads.getIndex.mockReset().mockResolvedValue(indexText());
  downloads.getArtifact.mockReset().mockImplementation(async release => artifacts.get(release.version)!);
  world = await createImportWorld(services)(artifacts.get('1.0.0')!);
  updates = createWorldUpdates({ ...services, events: new EventHub(), downloads });
  app = new Hono().onError(errorHandler).route(base, createWorldRoutes({
    ...services, worldUpdates: updates, importWorld: createImportWorld(services), exportWorld: createExportWorld(services),
    deleteWorld: createDeleteWorld({ ...services, transaction: bindTransaction(db), onWorldDeleted: updates.cancelForWorld }),
  }));
});
afterEach(async () => {
  await updates.shutdown();
  db.close();
  await rm(root, { recursive: true, force: true });
});

describe('world update HTTP projection', () => {
  it('reads versions, detail and list locally without fetching the release source', async () => {
    const result = await data<{ item: WorldVersions }>(await app.request(base + '/' + world.id + '/versions'));
    expect(result).toEqual({ item: { worldId: world.id, currentVersion: '1.0.0', latestVersion: null,
      updateStatus: 'not_checked', lastSuccessAt: null, lastAttemptAt: null, errorCode: null, versions: [] } });
    const detail = await data<{ item: Record<string, unknown> }>(await app.request(base + '/' + world.id));
    expect(detail.item).toMatchObject({ publication: publication('1.0.0'),
      currentVersion: '1.0.0', latestVersion: null, updateStatus: 'not_checked' });
    const list = await data<{ items: Record<string, unknown>[] }>(await app.request(base));
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id: world.id, publication: publication('1.0.0'),
      currentVersion: '1.0.0', latestVersion: null, updateStatus: 'not_checked' });
    for (const item of [detail.item, list.items[0]!]) {
      for (const field of ['versions', 'lastSuccessAt', 'lastAttemptAt', 'errorCode', 'artifact']) expect(item).not.toHaveProperty(field);
    }
    expect(downloads.getIndex).not.toHaveBeenCalled();
    expect(downloads.getArtifact).not.toHaveBeenCalled();
  });

  it('refreshes explicitly and returns the same item view on subsequent offline reads', async () => {
    const refreshed = await data<{ item: WorldVersions }>(await post('/versions/refresh'));
    expect(refreshed.item).toMatchObject({ worldId: world.id, currentVersion: '1.0.0', latestVersion: '2.0.0',
      updateStatus: 'ready', lastSuccessAt: expect.any(Number), lastAttemptAt: expect.any(Number), errorCode: null });
    expect(refreshed.item.versions).toEqual([record('2.0.0'), record('1.0.0')].map(item => ({ ...item, supported: true })));
    expect(downloads.getIndex).toHaveBeenCalledExactlyOnceWith(updateUrl, expect.any(AbortSignal));
    expect(await data(await app.request(base + '/' + world.id + '/versions'))).toEqual(refreshed);
    const list = await data<{ items: Record<string, unknown>[] }>(await app.request(base));
    expect(list.items[0]).toMatchObject({ currentVersion: '1.0.0', latestVersion: '2.0.0', updateStatus: 'ready' });
    expect(list.items[0]).not.toHaveProperty('versions');
    expect(downloads.getIndex).toHaveBeenCalledTimes(1);
    expect(downloads.getArtifact).not.toHaveBeenCalled();
  });

  it('applies an exact version through the public path and returns publication plus the installed detail', async () => {
    await data(await post('/versions/refresh'));
    const result = await data<{ item: Record<string, unknown> }>(await post('/apply-version', applyBody()));
    expect(result.item).toMatchObject({ id: world.id, revision: world.revision + 1, specVersion: '0.2',
      publication: publication('2.0.0'), currentVersion: '2.0.0', latestVersion: '2.0.0', updateStatus: 'ready',
      characters: [{ id: 'player', content: 'Prompt 2.0.0' }], openings: card('2.0.0').data.openings });
    expect(result.item).not.toHaveProperty('state');
    expect(result.item).not.toHaveProperty('versions');
    expect(downloads.getArtifact).toHaveBeenCalledExactlyOnceWith(record('2.0.0'), expect.any(AbortSignal));
    expect(await data(await app.request(base + '/' + world.id))).toEqual(result);
    const stale = await post('/apply-version', applyBody('1.0.0'));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ success: false, errorCode: 'WORLD_REVISION_CONFLICT', data: null });
    expect(services.worlds.require(world.id).publication?.release.version).toBe('2.0.0');
    expect(downloads.getArtifact).toHaveBeenCalledTimes(1);
  });

  it('preserves cached versions and its success time after a failed explicit refresh', async () => {
    const before = await data<{ item: WorldVersions }>(await post('/versions/refresh'));
    downloads.getIndex.mockRejectedValueOnce(new AppError('WORLD_DOWNLOAD_FAILED'));
    const failed = await post('/versions/refresh');
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(await failed.json()).toMatchObject({ success: false, errorCode: 'WORLD_DOWNLOAD_FAILED', data: null });
    const after = await data<{ item: WorldVersions }>(await app.request(base + '/' + world.id + '/versions'));
    expect(after.item).toMatchObject({ updateStatus: 'failed', latestVersion: '2.0.0',
      lastSuccessAt: before.item.lastSuccessAt, versions: before.item.versions, errorCode: 'WORLD_DOWNLOAD_FAILED' });
    expect(downloads.getIndex).toHaveBeenCalledTimes(2);
  });

  it('revalidates unchanged resources and originals, then changes ETags and bytes across an installation', async () => {
    const cached = new Map<string, string>();
    for (const suffix of ['/resources/assets/scene.txt', '/original']) {
      const response = await app.request(base + '/' + world.id + suffix);
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-cache');
      const etag = response.headers.get('ETag')!;
      expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
      cached.set(suffix, etag);
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes).toEqual(suffix === '/original' ? Buffer.from(artifacts.get('1.0.0')!.bytes) : Buffer.from('scene from 1.0.0'));
      const unchanged = await app.request(base + '/' + world.id + suffix, { headers: { 'If-None-Match': 'W/' + etag } });
      expect(unchanged.status).toBe(304);
      expect(unchanged.headers.get('ETag')).toBe(etag);
      expect(unchanged.headers.get('Cache-Control')).toBe('no-cache');
      expect(await unchanged.text()).toBe('');
      const head = await app.request(base + '/' + world.id + suffix, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('ETag')).toBe(etag);
      expect(await head.text()).toBe('');
    }
    await data(await post('/versions/refresh'));
    await data(await post('/apply-version', applyBody()));
    for (const [suffix, oldEtag] of cached) {
      const response = await app.request(base + '/' + world.id + suffix, { headers: { 'If-None-Match': oldEtag } });
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-cache');
      const etag = response.headers.get('ETag')!;
      expect(etag).not.toBe(oldEtag);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(suffix === '/original'
        ? Buffer.from(artifacts.get('2.0.0')!.bytes) : Buffer.from('scene from 2.0.0'));
      const unchanged = await app.request(base + '/' + world.id + suffix, { headers: { 'If-None-Match': etag } });
      expect(unchanged.status).toBe(304);
      expect(await unchanged.text()).toBe('');
    }
  });
});
