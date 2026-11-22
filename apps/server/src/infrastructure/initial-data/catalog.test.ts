import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { loadInitialData } from './catalog.js';

const manifest = {
  defaultPresetId: 'template',
  presets: [{ id: 'template', file: '标准.json' }],
  worlds: [{ id: 'inn', file: '小饭馆.zip' }],
};
let root: string;
function writeManifest(value: unknown) {
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(value));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sr-catalog-'));
  for (const directory of ['presets', 'worlds']) mkdirSync(join(root, directory));
  writeManifest(manifest);
  writeFileSync(join(root, 'presets', '标准.json'), '{"name":"test"}');
  writeFileSync(join(root, 'worlds', '小饭馆.zip'), 'world');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('loads registered entries in order and reads world bytes on demand', async () => {
  writeManifest({ ...manifest, presets: [...manifest.presets, { id: 'extra', file: 'another.json' }] });
  writeFileSync(join(root, 'presets', 'another.json'), '{}');
  writeFileSync(join(root, 'presets', 'unlisted.json'), 'invalid');
  const catalog = loadInitialData(root);
  expect(catalog.presets.map(p => p.id)).toEqual(['template', 'extra']);
  expect(catalog.presets[0]!.document).toEqual({ name: 'test' });
  writeFileSync(join(root, 'worlds', '小饭馆.zip'), 'new content');
  expect(await catalog.worlds[0]!.readBytes()).toEqual(Buffer.from('new content'));
});

it.each([
  { ...manifest, presets: [...manifest.presets, ...manifest.presets] },
  { ...manifest, worlds: [...manifest.worlds, ...manifest.worlds] },
  { ...manifest, defaultPresetId: 'unknown' },
  { ...manifest, worlds: [{ id: '../invalid', file: '小饭馆.zip' }] },
  ...['../escape.zip', '/absolute.zip', 'windows\\escape.zip', 'wrong.json', 'missing.zip'].map(file =>
    ({ ...manifest, worlds: [{ id: 'inn', file }] })),
])('rejects an invalid manifest or missing release asset', value => {
  writeManifest(value);
  expect(() => loadInitialData(root)).toThrow('INITIAL_DATA_ERROR');
});

it('reports invalid preset JSON with its source and stable ID', () => {
  writeFileSync(join(root, 'presets', '标准.json'), '{');
  expect(() => loadInitialData(root)).toThrow('presets/标准.json (template)');
});

it('rejects linked release files and category directories', async () => {
  const catalog = loadInitialData(root);
  const path = join(root, 'worlds', '小饭馆.zip');
  rmSync(path);
  symlinkSync(join(root, 'manifest.json'), path);
  await expect(catalog.worlds[0]!.readBytes()).rejects.toThrow('expected a regular file');
  expect(() => loadInitialData(root)).toThrow('expected a regular file');
  rmSync(join(root, 'worlds'), { recursive: true });
  symlinkSync(join(root, 'presets'), join(root, 'worlds'));
  expect(() => loadInitialData(root)).toThrow('expected a directory');
});
