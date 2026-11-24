import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readImportPackage, buildWorldPackage } from './archive.js';
import { inspectWorldSource, prepareWorldSourcePackage } from './authoring.js';
import { validateAssets } from './assets.js';
import { WorldFileStore } from './files.js';
import { parseCard } from './parser.js';
import { unzipBytes, worldCardFixture, zipBytes } from './test-fixtures.js';

let root: string;
let files: WorldFileStore;
const assetPath = 'assets/characters/player/default.webp';
const cardWithSprite = (asset = 'sr-asset://' + assetPath) => {
  const raw = worldCardFixture();
  return parseCard({ ...raw, data: { ...raw.data, characters: [
    { ...raw.data.characters[0], sprites: [{ id: 'default', asset, description: '平静站立' }] },
  ] } });
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sr-character-sprite-assets-'));
  files = new WorldFileStore(root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('character sprite resources', () => {
  it('rejects packaged sprite references in standalone JSON and does not fetch online assets', async () => {
    const card = cardWithSprite();
    const staged = await files.stageImport('json-card', 'json', Buffer.from(JSON.stringify(card)));
    await expect(readImportPackage(staged)).rejects.toThrow('$.data.characters[0].sprites[0].asset');
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network expected'));
    await expect(validateAssets(cardWithSprite('https://images.example/player.webp'), null)).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([assetPath, 'assets/characters/player/$1.webp'])('checks literal ZIP sprite existence: %s', async path => {
    const card = cardWithSprite('sr-asset://' + path);
    const staged = await files.stageImport('missing-file', 'zip', await zipBytes([
      { name: 'world.json', data: JSON.stringify(card) },
    ]));
    await expect(readImportPackage(staged)).rejects.toThrow('$.data.characters[0].sprites[0].asset');
  });

  it('preserves sprite metadata and resource bytes through ZIP import and export', async () => {
    const card = cardWithSprite();
    const pixels = Buffer.from([0, 1, 2, 255]);
    const staged = await files.stageImport('sprite-card', 'zip', await zipBytes([
      { name: 'world.json', data: JSON.stringify(card) },
      { name: assetPath, data: pixels },
    ]));
    const imported = await readImportPackage(staged);
    await files.publishImport(staged);
    const exported = await buildWorldPackage(files, 'sprite-card', imported);
    try {
      const contents = await unzipBytes(await readFile(exported.path));
      expect(JSON.parse(contents['world.json']!.toString())).toEqual(card);
      expect(contents[assetPath]).toEqual(pixels);
    } finally {
      await exported.cleanup();
    }
  });

  it('uses the same sprite validation for offline checks and source-directory packaging', async () => {
    const source = join(root, 'author-source');
    const card = cardWithSprite();
    await mkdir(join(source, 'assets/characters/player'), { recursive: true });
    await writeFile(join(source, 'world.json'), JSON.stringify(card));
    await expect(inspectWorldSource(source)).rejects.toThrow('$.data.characters[0].sprites[0].asset');
    await writeFile(join(source, assetPath), 'sprite bytes');
    const inspected = await inspectWorldSource(source);
    expect(inspected.card.data.characters[0]?.sprites).toEqual(card.data.characters[0]?.sprites);
    const packaged = await prepareWorldSourcePackage(source);
    try {
      expect(packaged.inspection.card).toEqual(card);
      expect(packaged.inspection.packageFiles).toContain(assetPath);
    } finally {
      await packaged.cleanup();
    }
  });
});
