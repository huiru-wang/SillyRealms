import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, open, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportFilename, getWorldPaths, WorldFileStore } from './files.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});

let root: string;
let files: WorldFileStore;
const bytes = (text: string) => Buffer.from(text, 'utf8');
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sr-v2-world-files-'));
  files = new WorldFileStore(root);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); vi.clearAllMocks(); });

describe('fixed world file layout', () => {
  it('derives paths from root and safe world IDs, and export names from current names', () => {
    expect(getWorldPaths(root, 'world-one')).toEqual({
      root: join(root, 'worlds', 'world-one'),
      source: join(root, 'worlds', 'world-one', 'source'),
      package: join(root, 'worlds', 'world-one', 'package'),
    });
    for (const id of ['..', '../escape', '/absolute', 'nested/world', 'UPPER']) {
      expect(() => files.paths(id)).toThrow('INVALID_WORLD_ID');
    }
    expect(exportFilename('雾港')).toBe('雾港.zip');
    expect(exportFilename('A/B:世界')).toBe('A_B_世界.zip');
    expect(exportFilename('CON')).toBe('_CON.zip');
    expect(exportFilename('..')).toBe('world.zip');
    expect(Buffer.byteLength(exportFilename('界'.repeat(150)))).toBeLessThanOrEqual(244);
  });

  it('preserves source bytes independently of package resources and ignores arbitrary upload names', async () => {
    expect(await files.readOriginal('world-one')).toBeNull();
    await files.saveOriginal('world-one', 'json', bytes('{"name":"imported"}\n'));
    const source = files.paths('world-one').source;
    await writeFile(join(source, 'upload-name.json'), 'ignored');
    expect(await files.readOriginal('world-one')).toEqual({ format: 'json', bytes: bytes('{"name":"imported"}\n') });
    expect((await readdir(source)).sort()).toEqual(['original.json', 'upload-name.json']);
    await expect(files.saveOriginal('world-one', 'zip', bytes('different format'))).rejects.toThrow('WORLD_SOURCE_FORMAT_CONFLICT');
    expect(await readFile(join(source, 'original.json'), 'utf8')).toBe('{"name":"imported"}\n');
  });

  it('atomically replaces the same format and preserves the prior original on rename failure', async () => {
    await files.saveOriginal('world-one', 'json', bytes('old'));
    vi.mocked(rename).mockRejectedValueOnce(new Error('simulated disk failure'));
    await expect(files.saveOriginal('world-one', 'json', bytes('new'))).rejects.toThrow('simulated disk failure');
    expect(await files.readOriginal('world-one')).toEqual({ format: 'json', bytes: bytes('old') });
    expect(await readdir(files.paths('world-one').source)).toEqual(['original.json']);
    await files.saveOriginal('world-one', 'json', bytes('new'));
    expect(await files.readOriginal('world-one')).toEqual({ format: 'json', bytes: bytes('new') });
  });

  it('serializes source writes across store instances so concurrent imports cannot create two formats', async () => {
    const other = new WorldFileStore(root);
    const results = await Promise.allSettled([
      files.saveOriginal('world-one', 'json', bytes('json')),
      other.saveOriginal('world-one', 'zip', bytes('zip')),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((await readdir(files.paths('world-one').source)).length).toBe(1);
  });

  it('reports two originals as corruption instead of picking a file', async () => {
    await files.saveOriginal('world-one', 'json', bytes('{}'));
    await writeFile(join(files.paths('world-one').source, 'original.zip'), 'zip');
    await expect(files.readOriginal('world-one')).rejects.toThrow('AMBIGUOUS_WORLD_ORIGINAL');
    await expect(files.saveOriginal('world-one', 'json', bytes('new'))).rejects.toThrow('AMBIGUOUS_WORLD_ORIGINAL');
  });

  it('resolves nested package files while rejecting traversal and symbolic links', async () => {
    const packageRoot = files.paths('world-one').package;
    await mkdir(join(packageRoot, 'assets', 'images'), { recursive: true });
    await writeFile(join(packageRoot, 'assets', 'images', 'cover.txt'), 'image');
    const resolved = await files.resolvePackageFile('world-one', 'assets/images/cover.txt');
    expect(resolved.path).toBe(await realpath(join(packageRoot, 'assets', 'images', 'cover.txt')));
    expect(resolved.stat.isFile()).toBe(true);
    for (const path of ['../source/original.json', '/absolute', 'assets/../secret', 'assets//cover', 'C:/secret', 'assets\\secret']) {
      await expect(files.resolvePackageFile('world-one', path)).rejects.toThrow('INVALID_WORLD_PACKAGE_PATH');
    }
    await expect(files.resolvePackageFile('world-one', 'assets/images/COVER.txt')).rejects.toThrow('WORLD_PACKAGE_FILE_NOT_FOUND');
    await writeFile(join(root, 'outside.txt'), 'outside');
    await symlink(join(root, 'outside.txt'), join(packageRoot, 'assets', 'link.txt'));
    await expect(files.resolvePackageFile('world-one', 'assets/link.txt')).rejects.toThrow('INVALID_WORLD_PACKAGE_FILE');
    await symlink(root, join(packageRoot, 'linked'));
    await expect(files.resolvePackageFile('world-one', 'linked/outside.txt')).rejects.toThrow('INVALID_WORLD_PACKAGE_FILE');
  });

  it('closes streaming handles after completion and cancellation', async () => {
    await files.saveOriginal('world-one', 'json', bytes('{"original":true}'));
    const original = await files.openOriginal('world-one');
    const originalHandle = await vi.mocked(open).mock.results.at(-1)!.value;
    expect(original?.filename).toBe('original.json');
    expect(await new Response(original!.body).text()).toBe('{"original":true}');
    await vi.waitFor(() => expect(originalHandle.fd).toBe(-1));

    const packageRoot = files.paths('world-one').package;
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'large.mp4'), Buffer.alloc(1024 * 1024));
    const media = await files.openPackageFile('world-one', 'large.mp4');
    const mediaHandle = await vi.mocked(open).mock.results.at(-1)!.value;
    expect(media.size).toBe(1024 * 1024);
    await media.body.cancel();
    await vi.waitFor(() => expect(mediaHandle.fd).toBe(-1));
  });

  it('rejects symlinked world-owned directories and source files', async () => {
    await mkdir(join(root, 'outside'));
    await symlink(join(root, 'outside'), join(root, 'worlds'));
    await expect(files.saveOriginal('world-one', 'json', bytes('{}'))).rejects.toThrow('INVALID_WORLD_DIRECTORY');
    await rm(join(root, 'worlds'));
    await files.saveOriginal('world-one', 'json', bytes('{}'));
    const source = files.paths('world-one').source;
    await rm(join(source, 'original.json'));
    await writeFile(join(root, 'outside.txt'), 'outside');
    await symlink(join(root, 'outside.txt'), join(source, 'original.json'));
    await expect(files.readOriginal('world-one')).rejects.toThrow('INVALID_WORLD_ORIGINAL');
    await expect(files.saveOriginal('world-one', 'json', bytes('new'))).rejects.toThrow('INVALID_WORLD_ORIGINAL');
    expect(await readFile(join(root, 'outside.txt'), 'utf8')).toBe('outside');
  });
});
