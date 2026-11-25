import { mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../infrastructure/database/connection.js';
import { createServices } from '../services.js';
import { unzipBytes, worldCardFixture, zipBytes } from '../modules/worlds/test-fixtures.js';
import { createImportWorld, type ImportWorld } from './import-world.js';
import { createExportWorld, type ExportWorld } from './export-world.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

let db: DatabaseSync;
let root: string;
let services: ReturnType<typeof createServices>;
let importWorld: ImportWorld;
let exportWorld: ExportWorld;
beforeEach(async () => {
  db = openDatabase(':memory:');
  root = await mkdtemp(join(tmpdir(), 'sr-v2-export-world-'));
  services = createServices(db, root);
  services.settings.ensure({ defaultPresetId: null, defaultApiModelConfigId: null });
  importWorld = createImportWorld({ worlds: services.worlds, settings: services.settings });
  exportWorld = createExportWorld({ worlds: services.worlds });
});
afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
});
const input = () => ({ format: 'json' as const, bytes: Buffer.from(JSON.stringify(worldCardFixture())) });

describe('export world use case', () => {
  it('builds ZIP from current definition, tags and package while retaining the unchanged original', async () => {
    const raw = worldCardFixture();
    const original = await zipBytes([
      { name: 'world.json', data: JSON.stringify({ ...raw, spec: 'world_card' }) },
      { name: 'assets/scene.txt', data: 'old resource' },
    ]);
    const world = await importWorld({ format: 'zip', bytes: original });
    services.worlds.update(world.id, { name: '新的世界', tags: ['当前标签'], extensions: { author_key: 'current' } });
    services.worlds.setState(world.id, { coins: 999 });
    await writeFile(join(services.worlds.paths(world.id).package, 'assets', 'scene.txt'), 'current resource');
    const download = await exportWorld(world.id);
    expect(download.filename).toBe('新的世界.zip');
    const entries = await unzipBytes(new Uint8Array(await new Response(download.body).arrayBuffer()));
    expect(Object.keys(entries).sort()).toEqual(['assets/scene.txt', 'world.json']);
    expect(entries['assets/scene.txt']!.toString()).toBe('current resource');
    const card = JSON.parse(entries['world.json']!.toString());
    expect(card).toMatchObject({ spec_version: '0.1', data: {
      name: '新的世界', tags: ['当前标签'], state: raw.data.state, extensions: { author_key: 'current' },
    } });
    expect(card).not.toHaveProperty('spec');
    expect(card.data.state).not.toEqual({ coins: 999 });
    expect(await services.worlds.readOriginal(world.id)).toEqual({ format: 'zip', bytes: original });
    await vi.waitFor(async () => expect(await readdir(join(root, 'staging'))).toEqual([]));
  });

  it('keeps local preset references out of portable cards and applies the receiving app defaults', async () => {
    const appReply = services.presets.create({ ...services.presets.getDefault('reply_assist'), name: 'App reply' });
    const worldReply = services.presets.create({ ...services.presets.getDefault('reply_assist'), name: 'World reply' });
    services.settings.update({ defaultReplyAssistPresetId: appReply.id });
    const world = await importWorld(input());
    services.worlds.updateManagement(world.id, { defaultReplyAssistPresetId: worldReply.id, expectedRevision: world.revision });
    const download = await exportWorld(world.id);
    const bytes = new Uint8Array(await new Response(download.body).arrayBuffer());
    const entries = await unzipBytes(bytes), card = JSON.parse(entries['world.json']!.toString());
    expect(JSON.stringify(card)).not.toContain(worldReply.id);
    expect(card.data).not.toHaveProperty('defaultReplyAssistPresetId');
    expect(card.data).not.toHaveProperty('default_reply_assist_preset_id');
    const imported = await importWorld({ format: 'zip', bytes });
    expect(imported.defaultReplyAssistPresetId).toBe(appReply.id);
    expect(services.worlds.require(world.id).defaultReplyAssistPresetId).toBe(worldReply.id);
  });

  it.each([true, false])('round-trips the current cover mosaic flag (%s) through JSON and ZIP without changing the original', async enabled => {
    const raw = worldCardFixture();
    const author = { release: '1.0', notes: ['keep', false, 7] };
    const source = Buffer.from(JSON.stringify({ ...raw, data: { ...raw.data,
      extensions: { author, cover_mosaic_enabled: !enabled },
    } }, null, 2) + '\n');
    const world = await importWorld({ format: 'json', bytes: source });
    expect(world.coverMosaicEnabled).toBe(!enabled);
    services.worlds.updateManagement(world.id, { coverMosaicEnabled: enabled, expectedRevision: world.revision });
    const download = await exportWorld(world.id);
    const bytes = new Uint8Array(await new Response(download.body).arrayBuffer());
    const entries = await unzipBytes(bytes);
    const card = JSON.parse(entries['world.json']!.toString());
    expect(card.data.extensions).toEqual({ author, cover_mosaic_enabled: enabled });
    expect(card.data).not.toHaveProperty('coverMosaicEnabled');
    for (const input of [{ format: 'zip' as const, bytes }, { format: 'json' as const, bytes: entries['world.json']! }]) {
      const imported = await importWorld(input);
      expect(imported).toMatchObject({ coverMosaicEnabled: enabled, extensions: { author, cover_mosaic_enabled: enabled } });
    }
    expect(await services.worlds.readOriginal(world.id)).toEqual({ format: 'json', bytes: source });
  });

  it('exports JSON-only worlds to ZIP and rejects unrepresentable textual descriptions', async () => {
    const world = await importWorld(input());
    const download = await exportWorld(world.id);
    const entries = await unzipBytes(new Uint8Array(await new Response(download.body).arrayBuffer()));
    expect(Object.keys(entries)).toEqual(['world.json']);
    expect(JSON.parse(entries['world.json']!.toString())).toEqual(worldCardFixture());
    services.worlds.update(world.id, { description: 'plain legacy description' });
    await expect(exportWorld(world.id)).rejects.toThrow('INVALID_WORLD_CARD');
    expect(services.worlds.require(world.id).description).toBe('plain legacy description');
    await expect(exportWorld('missing')).rejects.toThrow('WORLD_NOT_FOUND');
  });

  it('closes and removes the temporary ZIP on stream cancellation', async () => {
    const bytes = await zipBytes([
      { name: 'world.json', data: JSON.stringify(worldCardFixture()) },
      { name: 'assets/scene.mp4', data: Buffer.alloc(512 * 1024, 31) },
    ]);
    const world = await importWorld({ format: 'zip', bytes });
    const download = await exportWorld(world.id);
    const handle = await vi.mocked(open).mock.results.at(-1)!.value;
    expect(download.size).toBeGreaterThan(512 * 1024);
    await download.body.cancel();
    await vi.waitFor(async () => {
      expect(handle.fd).toBe(-1);
      expect(await readdir(join(root, 'staging'))).toEqual([]);
    });
    expect(await services.worlds.readOriginal(world.id)).not.toBeNull();
  });

  it('cleans a partial export when reading a resource fails', async () => {
    const bytes = await zipBytes([
      { name: 'world.json', data: JSON.stringify(worldCardFixture()) },
      { name: 'assets/file.txt', data: 'keep' },
    ]);
    const world = await importWorld({ format: 'zip', bytes });
    vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error('disk failure'), { code: 'EIO' }));
    await expect(exportWorld(world.id)).rejects.toThrow('WORLD_EXPORT_FAILED');
    expect(await readdir(join(root, 'staging'))).toEqual([]);
    expect(await readFile(join(services.worlds.paths(world.id).package, 'assets', 'file.txt'), 'utf8')).toBe('keep');
  });

  it('rejects symlink resources without following or modifying their external targets', async () => {
    const world = await importWorld(input());
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'outside');
    await symlink(outside, join(services.worlds.paths(world.id).package, 'link.txt'));
    await expect(exportWorld(world.id)).rejects.toThrow('INVALID_WORLD_PACKAGE_FILE');
    expect(await readFile(outside, 'utf8')).toBe('outside');
    expect(await readdir(join(root, 'staging'))).toEqual([]);
  });
});
