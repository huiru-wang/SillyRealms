import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../infrastructure/database/connection.js';
import { AppError } from '../errors.js';
import { createServices } from '../services.js';
import { narrativePreset } from '../testing/fixtures.js';
import { worldCardFixture, zipBytes } from '../modules/worlds/test-fixtures.js';
import { createImportWorld, type ImportWorld } from './import-world.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

let db: DatabaseSync;
let root: string;
let services: ReturnType<typeof createServices>;
let importWorld: ImportWorld;
beforeEach(async () => {
  db = openDatabase(':memory:');
  root = await mkdtemp(join(tmpdir(), 'sr-v2-import-world-'));
  services = createServices(db, root);
  services.settings.ensure({ defaultPresetId: null, defaultApiModelConfigId: null });
  importWorld = createImportWorld({ worlds: services.worlds, settings: services.settings });
});
afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
});
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
async function names(directory: string) {
  return readdir(join(root, directory)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
}

describe('import world use case', () => {
  it('imports a no-spec JSON card, retains exact source bytes and applies current settings defaults', async () => {
    const preset = services.presets.create(narrativePreset());
    const model = services.models.create({ name: 'Model', providerId: 'test', modelId: 'test', credentialRef: 'keychain' });
    services.settings.update({ defaultPresetId: preset.id, defaultApiModelConfigId: model.id });
    const bytes = Buffer.from(JSON.stringify(worldCardFixture(), null, 2) + '\n');
    const world = await importWorld({ format: 'json', bytes });
    expect(world).toMatchObject({ name: '雾港', tags: ['冒险'], state: { coins: 3 }, defaultPresetId: preset.id, defaultApiModelConfigId: model.id });
    expect(await services.worlds.readOriginal(world.id)).toEqual({ format: 'json', bytes });
    expect(await names('staging')).toEqual([]);
    expect(await readdir(services.worlds.paths(world.id).source)).toEqual(['original.json']);
  });

  it('imports ZIP resources after validating component and image references', async () => {
    const raw = worldCardFixture();
    const card = { ...raw, spec: 'world_card', data: { ...raw.data, cover: 'sr-asset://assets/cover.png',
      components: [{ id: 'intro', path: 'sr-asset://components/intro.tsx' }],
      description: { type: 'component', component: 'intro' },
    } };
    const bytes = await zipBytes([
      { name: 'world.json', data: JSON.stringify(card) },
      { name: 'components/intro.tsx', data: 'export default function Intro(){return <div>港口</div>}' },
      { name: 'assets/cover.png', data: 'image' },
    ]);
    const world = await importWorld({ format: 'zip', bytes });
    expect(world.description).toEqual({ type: 'component', component: 'intro' });
    expect(await services.worlds.readOriginal(world.id)).toEqual({ format: 'zip', bytes });
    expect(await readFile((await services.worlds.resolvePackageFile(world.id, 'assets/cover.png')).path, 'utf8')).toBe('image');
    expect(await names('staging')).toEqual([]);
  });

  it('rejects malformed JSON, invalid UTF-8 and JSON-only package references without leftover files', async () => {
    const raw = worldCardFixture();
    for (const bytes of [Buffer.from('{broken'), Buffer.from([255]), json({ ...raw, data: { ...raw.data, cover: 'sr-asset://assets/missing.png' } })]) {
      await expect(importWorld({ format: 'json', bytes })).rejects.toThrow('INVALID_WORLD_CARD');
      expect(services.worlds.list()).toEqual([]);
      expect(await names('staging')).toEqual([]);
      expect(await names('worlds')).toEqual([]);
    }
  });

  it('rejects ZIP traversal, duplicate paths, Unicode/case collisions and symlink entries', async () => {
    const manifest = { name: 'world.json', data: JSON.stringify(worldCardFixture()) };
    const traversal = await zipBytes([manifest, { name: 'assets/evil', data: 'outside' }]);
    for (let offset = traversal.indexOf('assets/evil'); offset !== -1; offset = traversal.indexOf('assets/evil', offset + 1)) {
      traversal.write('../bad/evil', offset);
    }
    const archives = [
      traversal,
      await zipBytes([manifest, { name: 'assets/same', data: 'one' }, { name: 'assets/same', data: 'two' }]),
      await zipBytes([manifest, { name: 'assets/FILE', data: 'one' }, { name: 'assets/file', data: 'two' }]),
      await zipBytes([manifest, { name: 'assets/é', data: 'one' }, { name: 'assets/e\u0301', data: 'two' }]),
      await zipBytes([manifest, { name: 'assets/link', data: '/outside', mode: 0o120777 }]),
    ];
    for (const bytes of archives) {
      await expect(importWorld({ format: 'zip', bytes })).rejects.toThrow('INVALID_WORLD_PACKAGE');
      expect(services.worlds.list()).toEqual([]);
      expect(await names('staging')).toEqual([]);
      expect(await names('worlds')).toEqual([]);
    }
  });

  it('rejects CRC corruption, oversized entries and missing resources before publication', async () => {
    const manifest = { name: 'world.json', data: JSON.stringify(worldCardFixture()) };
    const corrupt = await zipBytes([manifest, { name: 'assets/file', data: 'unique-payload' }]);
    const payloadOffset = corrupt.indexOf('unique-payload');
    corrupt[payloadOffset] = corrupt[payloadOffset]! ^ 1;
    const oversized = await zipBytes([manifest]);
    const header = oversized.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    oversized.writeUInt32LE(11 * 1024 * 1024, header + 24);
    for (const bytes of [Buffer.from('not a zip'), corrupt, oversized]) {
      await expect(importWorld({ format: 'zip', bytes })).rejects.toThrow('INVALID_WORLD_PACKAGE');
      expect(await names('staging')).toEqual([]);
    }
    const raw = worldCardFixture();
    const missing = await zipBytes([{ name: 'world.json', data: JSON.stringify({ ...raw, data: { ...raw.data, cover: 'sr-asset://assets/missing' } }) }]);
    await expect(importWorld({ format: 'zip', bytes: missing })).rejects.toThrow('INVALID_WORLD_CARD');
    expect(services.worlds.list()).toEqual([]);
  });

  it('compensates published files when the database write fails and preserves existing worlds', async () => {
    const existing = await importWorld({ format: 'json', bytes: json(worldCardFixture()) });
    vi.spyOn(services.worlds, 'create').mockImplementationOnce(() => { throw new AppError('RESOURCE_CONFLICT'); });
    await expect(importWorld({ format: 'json', bytes: json(worldCardFixture()) })).rejects.toThrow('RESOURCE_CONFLICT');
    expect(services.worlds.list().map(world => world.id)).toEqual([existing.id]);
    expect(await names('worlds')).toEqual([existing.id]);
    expect(await names('staging')).toEqual([]);
    expect(await services.worlds.readOriginal(existing.id)).not.toBeNull();
  });

  it('removes the newly committed world if finalization fails', async () => {
    const existing = await importWorld({ format: 'json', bytes: json(worldCardFixture()) });
    vi.spyOn(services.worlds, 'finishImport').mockImplementationOnce(() => { throw new Error('finalization failed'); });
    await expect(importWorld({ format: 'json', bytes: json(worldCardFixture()) })).rejects.toThrow('finalization failed');
    expect(services.worlds.list().map(world => world.id)).toEqual([existing.id]);
    expect(await names('worlds')).toEqual([existing.id]);
    expect(await names('staging')).toEqual([]);
  });

  it('reports a failed compensation and leaves its orphan directory available for deletion retry', async () => {
    const prepare = vi.spyOn(services.worlds, 'prepareImport');
    vi.spyOn(services.worlds, 'create').mockImplementationOnce(() => { throw new AppError('RESOURCE_CONFLICT'); });
    vi.mocked(rm).mockRejectedValueOnce(new Error('cleanup failed'));
    await expect(importWorld({ format: 'json', bytes: json(worldCardFixture()) })).rejects.toThrow('WORLD_IMPORT_CLEANUP_FAILED');
    const stage = await prepare.mock.results[0]!.value;
    expect(services.worlds.get(stage.id)).toBeNull();
    expect(await names('worlds')).toEqual([stage.id]);
    expect(await services.worlds.delete(stage.id)).toBe(true);
    expect(await names('worlds')).toEqual([]);
  });
});
