import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, lstat, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../infrastructure/database/connection.js';
import { createServices } from '../../services.js';
import { narrativePreset } from '../../testing/fixtures.js';
import { assertWorldReplacementCompatible, type World, type WorldPublication } from './service.js';
import { WorldFileStore } from './files.js';
import { unzipBytes, worldCardFixture, zipBytes } from './test-fixtures.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename), writeFile: vi.fn(actual.writeFile) };
});
const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const packageId = '8da0e392-2ea6-4ac1-a93a-b94abf6828a1';
const updateUrl = 'https://cdn.example.org/fog/releases.json';
const publication = (version = '1.0.0'): WorldPublication => ({
  package_id: packageId, authors: [{ name: '雾灯' }], creator_notes: '作者说明',
  release: { version, published_at: '2026-11-10T12:00:00+08:00', notes: '版本说明' },
  update_url: updateUrl,
});
const card = (version = '1.0.0') => {
  const value = worldCardFixture();
  return { ...value, spec_version: '0.2', data: { ...value.data, publication: publication(version) } };
};
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const rawIndex = '{\n  "package_id": "' + packageId + '", "schema_version": 1, "versions": []\n}\n';
let db: DatabaseSync, root: string, services: ReturnType<typeof createServices>;

beforeEach(async () => {
  vi.mocked(rename).mockReset().mockImplementation(realFs.rename);
  vi.mocked(writeFile).mockReset().mockImplementation(realFs.writeFile);
  db = openDatabase(':memory:');
  root = await mkdtemp(join(tmpdir(), 'sr-world-updates-'));
  services = createServices(db, root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await rm(root, { recursive: true, force: true });
});

async function install(format: 'json' | 'zip' = 'json') {
  const content = format === 'zip' ? await zipBytes([{ name: 'world.json', data: bytes(card()) }]) : bytes(card());
  const stage = await services.worlds.prepareImport({ format, bytes: content }, 'installed');
  await services.worlds.publishImport(stage);
  const world = services.worlds.create({ ...stage.content, id: stage.id });
  services.worlds.finishImport(stage);
  return world;
}

async function cacheIndex(world: World, text = rawIndex) {
  return services.worlds.saveReleaseIndex(world.id, { packageId, updateUrl, text }, () => true);
}

async function replacement(world: World, value = card('1.1.0'), guard?: () => void) {
  const stage = await services.worlds.prepareImport({ format: 'json', bytes: bytes(value) }, world.id);
  const permit = services.cache.acquireWorldUpdate(world.id);
  try {
    return await services.worlds.applyPreparedReplacement(stage, {
      expectedRevision: world.revision, packageId, updateUrl, playerCharacterIds: ['player'], permit, guard,
    });
  } finally {
    services.cache.releaseWorldUpdate(permit);
    await services.worlds.discardImport(stage);
  }
}

describe('raw release directory storage', () => {
  it('preserves exact text and mtime, ignores stale guards and rechecks source binding before rename', async () => {
    const world = await install();
    const before = await cacheIndex(world);
    expect(await services.worlds.readReleaseIndex(world.id)).toEqual(before);
    expect(before?.text).toBe(rawIndex);
    let checks = 0;
    expect(await services.worlds.saveReleaseIndex(world.id, { packageId, updateUrl, text: '{"new":true}' },
      () => ++checks === 1)).toBeNull();
    expect(checks).toBe(2);
    expect(await services.worlds.readReleaseIndex(world.id)).toEqual(before);
    const changed = { ...world.publication!, update_url: 'https://other.example.org/releases.json' };
    expect(await services.worlds.saveReleaseIndex(world.id, { packageId, updateUrl, text: '{"new":true}' }, () => {
      db.prepare('UPDATE worlds SET publication_json=? WHERE id=?').run(JSON.stringify(changed), world.id);
      return true;
    })).toBeNull();
    expect(await services.worlds.readReleaseIndex(world.id)).toEqual(before);
    expect((await readdir(services.worlds.paths(world.id).root)).sort()).toEqual(['package', 'releases.json', 'source']);
  });

  it('keeps the previous file on disk failure and cannot recreate a deleted world', async () => {
    const world = await install();
    const before = await cacheIndex(world);
    vi.mocked(rename).mockRejectedValueOnce(new Error('disk full'));
    await expect(services.worlds.saveReleaseIndex(world.id, { packageId, updateUrl, text: '{"new":true}' }, () => true))
      .rejects.toThrow('WORLD_RELEASE_INDEX_WRITE_FAILED');
    expect(await services.worlds.readReleaseIndex(world.id)).toEqual(before);
    const pending = cacheIndex(world, '{"late":true}');
    expect(services.worlds.deleteRecord(world.id)).toBe(true);
    await services.worlds.deleteFiles(world.id);
    expect(await pending).toBeNull();
    expect(await cacheIndex(world)).toBeNull();
    expect(await services.worlds.readReleaseIndex(world.id)).toBeNull();
    await expect(lstat(services.worlds.paths(world.id).root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not import a supplied root releases.json as trusted cache', async () => {
    const content = await zipBytes([
      { name: 'world.json', data: JSON.stringify(card()) }, { name: 'releases.json', data: rawIndex },
    ]);
    await expect(services.worlds.prepareImport({ format: 'zip', bytes: content })).rejects.toThrow();
    expect(services.worlds.listUpdateSources()).toEqual([]);
  });
});

describe('in-place world replacement', () => {
  it('preserves local identity, preferences and runtime state while replacing author content and originals', async () => {
    let world = await install();
    services.presets.create({ ...narrativePreset('Local'), id: 'local-preset' });
    services.models.create({ id: 'model', name: 'Local', providerId: 'provider', modelId: 'model', credentialRef: 'ref' });
    world = services.worlds.updateManagement(world.id, {
      expectedRevision: world.revision, name: '本地名字', tags: ['local'], coverMosaicEnabled: true,
      defaultPresetId: 'local-preset', defaultApiModelConfigId: 'model',
    });
    services.worlds.setState(world.id, { coins: 42 });
    const saved = await cacheIndex(world);
    const value = card('1.1.0');
    value.data.name = '新版作者名字';
    value.data.tags = ['author'];
    value.data.state.scopes.global.coins.initial = 99;
    value.data.publication = { ...publication('1.1.0'), authors: [{ name: 'New author' }], update_url: 'https://other.example.org/releases.json' };
    const updated = await replacement(world, value);
    expect(updated).toMatchObject({
      id: world.id, name: '本地名字', tags: ['local'], revision: world.revision + 1, createdAt: world.createdAt,
      state: { coins: 42 }, coverMosaicEnabled: true, defaultPresetId: 'local-preset', defaultApiModelConfigId: 'model',
      publication: { authors: [{ name: 'New author' }], update_url: updateUrl, release: { version: '1.1.0' } },
    });
    expect(await services.worlds.readOriginal(world.id)).toEqual({ format: 'json', bytes: bytes(value) });
    expect(await services.worlds.readReleaseIndex(world.id)).toEqual(saved);
    expect(services.worlds.listPage().items[0]?.publication).toEqual(updated.publication);
    expect(services.worlds.listUpdateSources()).toEqual([{ worldId: world.id, packageId, updateUrl }]);
    const exported = await services.worlds.buildExport(updated);
    const archive = await unzipBytes(await new Response(exported.body).arrayBuffer().then(value => new Uint8Array(value)));
    expect(Object.keys(archive)).toEqual(['world.json']);
    const exportedCard = JSON.parse(archive['world.json']!.toString()) as ReturnType<typeof card>;
    expect(exportedCard.data.publication).toEqual(updated.publication);
    expect(exportedCard.data.name).toBe('本地名字');
    expect(exported.revision).toBe(updated.revision);
  });

  it('restores both directories and leaves the cache and DB unchanged when a directory rename fails', async () => {
    const world = await install('zip'), before = await cacheIndex(world);
    const source = await services.worlds.readOriginal(world.id);
    const originalWorldJson = await readFile(join(services.worlds.paths(world.id).package, 'world.json'));
    const packagePath = services.worlds.paths(world.id).package;
    let failed = false;
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (!failed && to === packagePath) { failed = true; throw new Error('simulated disk failure'); }
      await realFs.rename(from, to);
    });
    await expect(replacement(world)).rejects.toThrow('WORLD_UPDATE_REPLACE_FAILED');
    expect(services.worlds.require(world.id)).toEqual(world);
    expect(await services.worlds.readOriginal(world.id)).toEqual(source);
    expect(await readFile(join(packagePath, 'world.json'))).toEqual(originalWorldJson);
    expect(await services.worlds.readReleaseIndex(world.id)).toEqual(before);
  });

  it('restores files on CAS conflict and rechecks the synchronous guard immediately before committing', async () => {
    const world = await install();
    await cacheIndex(world);
    const source = await services.worlds.readOriginal(world.id);
    let calls = 0;
    await expect(replacement(world, card('1.1.0'), () => {
      if (++calls === 3) {
        db.prepare('UPDATE worlds SET revision=revision+1 WHERE id=?').run(world.id);
      }
    })).rejects.toThrow('WORLD_REVISION_CONFLICT');
    expect(services.worlds.require(world.id).publication?.release.version).toBe('1.0.0');
    expect(await services.worlds.readOriginal(world.id)).toEqual(source);
    expect(await readdir(join(root, 'staging'))).toEqual([]);
    const refreshed = services.worlds.require(world.id);
    let guardCalls = 0;
    await expect(replacement(refreshed, card('1.1.0'), () => {
      if (++guardCalls === 3) throw new Error('cancelled just before commit');
    })).rejects.toThrow('WORLD_UPDATE_REPLACE_FAILED');
    expect(await services.worlds.readOriginal(world.id)).toEqual(source);
  });

  it('never rolls back a committed world when deleting its temporary backup fails', async () => {
    const world = await install();
    await cacheIndex(world);
    const remove = vi.spyOn(WorldFileStore.prototype, 'removeTemporaryDirectory');
    remove.mockRejectedValueOnce(new Error('cleanup failure'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updated = await replacement(world);
    expect(updated.publication?.release.version).toBe('1.1.0');
    expect(services.worlds.require(world.id).revision).toBe(world.revision + 1);
    expect(warning).toHaveBeenCalledWith('WORLD_UPDATE_BACKUP_CLEANUP_FAILED', { worldId: world.id });
    expect((await services.worlds.readOriginal(world.id))?.bytes).toEqual(bytes(card('1.1.0')));
  });

  it('rejects a resource that spans an update attempt even after rollback leaves revision unchanged', async () => {
    const world = await install('zip');
    const original = WorldFileStore.prototype.openPackageFile;
    vi.spyOn(WorldFileStore.prototype, 'openPackageFile').mockImplementationOnce(async function (this: WorldFileStore, ...args) {
      const result = await original.apply(this, args);
      const permit = services.cache.acquireWorldUpdate(world.id);
      services.cache.releaseWorldUpdate(permit);
      return result;
    });
    await expect(services.worlds.openPackageFile(world.id, 'world.json')).rejects.toThrow('WORLD_REVISION_CONFLICT');
    expect(services.worlds.require(world.id).revision).toBe(world.revision);
  });

  it('closes a resource captured across a content change and rejects management during update occupation', async () => {
    const world = await install('zip');
    const original = WorldFileStore.prototype.openPackageFile;
    let streamed: ReadableStream<Uint8Array> | undefined;
    vi.spyOn(WorldFileStore.prototype, 'openPackageFile').mockImplementationOnce(async function (this: WorldFileStore, ...args) {
      const result = await original.apply(this, args);
      streamed = result.body;
      services.worlds.updateManagement(world.id, { expectedRevision: world.revision, name: 'new name' });
      return result;
    });
    await expect(services.worlds.openPackageFile(world.id, 'world.json')).rejects.toThrow('WORLD_REVISION_CONFLICT');
    expect(await streamed!.getReader().read()).toEqual({ done: true, value: undefined });
    const permit = services.cache.acquireWorldUpdate(world.id);
    try {
      expect(() => services.worlds.updateManagement(world.id, { expectedRevision: world.revision + 1, name: 'busy' }))
        .toThrow('WORLD_UPDATE_IN_PROGRESS');
      await expect(services.worlds.getComponents(world.id)).rejects.toThrow('WORLD_UPDATE_IN_PROGRESS');
      await expect(services.worlds.buildExport(services.worlds.require(world.id))).rejects.toThrow('WORLD_UPDATE_IN_PROGRESS');
      expect(() => services.worlds.deleteRecord(world.id)).toThrow('WORLD_UPDATE_IN_PROGRESS');
    } finally { services.cache.releaseWorldUpdate(permit); }
  });
});

describe('retained-state compatibility', () => {
  const definition = () => ({
    specVersion: '0.2', publication: publication(),
    characters: card().data.characters,
    stateDefinition: {
      schema_version: 2,
      scopes: {
        global: { coins: { type: 'number', initial: 3, description: 'coins', min: 0, max: 100 } },
        session: { mood: { type: 'string', initial: '', description: 'mood' } },
        message: { bag: { type: 'json', initial: {}, description: 'bag' } },
      },
    },
  });
  it('keeps global roots/types and bounds even without sessions, and checks every retained player', () => {
    const current = definition();
    const removed = structuredClone(current); removed.stateDefinition.scopes.global = {} as typeof current.stateDefinition.scopes.global;
    expect(() => assertWorldReplacementCompatible(current, removed, [])).toThrow('global.coins');
    const tight = structuredClone(current); tight.stateDefinition.scopes.global.coins.min = 1;
    expect(() => assertWorldReplacementCompatible(current, tight, [])).toThrow('global.coins');
    const changed = structuredClone(current); changed.stateDefinition.scopes.global.coins.type = 'string';
    changed.stateDefinition.scopes.global.coins.initial = '' as unknown as number;
    delete (changed.stateDefinition.scopes.global.coins as { min?: number }).min;
    delete (changed.stateDefinition.scopes.global.coins as { max?: number }).max;
    expect(() => assertWorldReplacementCompatible(current, changed, [])).toThrow('global.coins');
    expect(() => assertWorldReplacementCompatible(current, current, ['missing-player'])).toThrow('missing-player');
  });
  it('allows relaxed ranges and changed initial/rules but only permits session/message schema changes without sessions', () => {
    const current = definition(), next = structuredClone(current);
    next.stateDefinition.scopes.global.coins.min = -10;
    next.stateDefinition.scopes.global.coins.max = 1000;
    next.stateDefinition.scopes.global.coins.initial = 99;
    expect(() => assertWorldReplacementCompatible(current, next, ['player'])).not.toThrow();
    next.stateDefinition.scopes.session = {} as typeof next.stateDefinition.scopes.session;
    next.stateDefinition.scopes.message = {} as typeof next.stateDefinition.scopes.message;
    expect(() => assertWorldReplacementCompatible(current, next, [])).not.toThrow();
    expect(() => assertWorldReplacementCompatible(current, next, ['player'])).toThrow('session.mood');
    const other = { ...current, publication: { ...publication(), package_id: 'd952f219-48ce-426d-997b-938d7558a214' } };
    expect(() => assertWorldReplacementCompatible(current, other, [])).toThrow('package_id');
  });
});
