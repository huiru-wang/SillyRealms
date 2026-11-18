import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

export type WorldPaths = { root: string; source: string; package: string };
export type OriginalFormat = 'json' | 'zip';
export type WorldOriginal = { format: OriginalFormat; bytes: Uint8Array };
export type PackageFile = { path: string; stat: Stats };
const sourceLimits: Record<OriginalFormat, number> = { json: 10 * 1024 * 1024, zip: 256 * 1024 * 1024 };
const sourceWrites = new Map<string, Promise<void>>();

/** Generated IDs are UUIDs; explicit IDs must be safe on case-insensitive filesystems too. */
export function assertWorldId(id: string): void {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id)) throw new Error('INVALID_WORLD_ID');
}

export function getWorldPaths(dataRoot: string, worldId: string): WorldPaths {
  assertWorldId(worldId);
  const root = resolve(dataRoot, 'worlds', worldId);
  return { root, source: join(root, 'source'), package: join(root, 'package') };
}

/** The export name comes from the current world name, never an original upload filename. */
export function exportFilename(worldName: string): string {
  if (typeof worldName !== 'string') throw new Error('INVALID_WORLD_NAME');
  let stem = worldName.trim().replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '');
  if (!stem || stem === '.' || stem === '..') stem = 'world';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = '_' + stem;
  // Leave room for the extension without cutting a UTF-8 code point.
  while (Buffer.byteLength(stem, 'utf8') > 240) stem = [...stem].slice(0, -1).join('');
  return stem + '.zip';
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function packageSegments(path: string): string[] {
  if (typeof path !== 'string' || !path || /[\\:\u0000-\u001f\u007f]/.test(path)) throw new Error('INVALID_WORLD_PACKAGE_PATH');
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || Buffer.byteLength(part, 'utf8') > 255)) {
    throw new Error('INVALID_WORLD_PACKAGE_PATH');
  }
  return parts;
}

async function withSourceWrite<T>(key: string, write: () => Promise<T>): Promise<T> {
  const previous = sourceWrites.get(key) ?? Promise.resolve();
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  sourceWrites.set(key, waiting);
  await previous;
  try {
    return await write();
  } finally {
    release();
    if (sourceWrites.get(key) === waiting) sourceWrites.delete(key);
  }
}

/** File layout only. ZIP import/export and database/filesystem orchestration remain world use cases. */
export class WorldFileStore {
  constructor(private readonly dataRoot: string) {}

  paths(worldId: string): WorldPaths {
    return getWorldPaths(this.dataRoot, worldId);
  }

  private async directory(worldId: string, leaf: 'source' | 'package', create = false): Promise<string> {
    assertWorldId(worldId);
    if (create) await mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
    // The configured data root may itself be a system alias (for example /tmp on macOS).
    let directory = await realpath(this.dataRoot);
    for (const segment of ['worlds', worldId, leaf]) {
      directory = join(directory, segment);
      if (create) {
        await mkdir(directory, { mode: 0o700 }).catch(error => {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        });
      }
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('INVALID_WORLD_DIRECTORY');
    }
    return directory;
  }

  private async originalAt(source: string): Promise<{ format: OriginalFormat; path: string; stat: Stats } | null> {
    let found: { format: OriginalFormat; path: string; stat: Stats } | null = null;
    for (const format of ['json', 'zip'] as const) {
      const path = join(source, 'original.' + format);
      const stat = await lstat(path).catch(error => { if (missing(error)) return null; throw error; });
      if (!stat) continue;
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('INVALID_WORLD_ORIGINAL');
      if (found) throw new Error('AMBIGUOUS_WORLD_ORIGINAL');
      found = { format, path, stat };
    }
    return found;
  }

  async saveOriginal(worldId: string, format: OriginalFormat, bytes: Uint8Array): Promise<void> {
    if (format !== 'json' && format !== 'zip') throw new Error('INVALID_WORLD_ORIGINAL_FORMAT');
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > sourceLimits[format]) {
      throw new Error('INVALID_WORLD_ORIGINAL_SIZE');
    }
    const source = await this.directory(worldId, 'source', true);
    await withSourceWrite(source, async () => {
      const current = await this.originalAt(source);
      // Switching formats is a future import policy, not a partially atomic two-file replacement.
      if (current && current.format !== format) throw new Error('WORLD_SOURCE_FORMAT_CONFLICT');
      const temporary = join(source, '.original-' + randomUUID());
      try {
        await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
        await rename(temporary, join(source, 'original.' + format));
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }

  async readOriginal(worldId: string): Promise<WorldOriginal | null> {
    const source = await this.directory(worldId, 'source').catch(error => { if (missing(error)) return null; throw error; });
    if (source === null) return null;
    const original = await this.originalAt(source);
    if (!original) return null;
    const file = await open(original.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size === 0 || stat.size > sourceLimits[original.format]) throw new Error('INVALID_WORLD_ORIGINAL_SIZE');
      return { format: original.format, bytes: await file.readFile() };
    } finally {
      await file.close();
    }
  }

  async resolvePackageFile(worldId: string, relativePath: string): Promise<PackageFile> {
    const parts = packageSegments(relativePath);
    const root = await this.directory(worldId, 'package');
    let current = root;
    let stat: Stats | undefined;
    for (let index = 0; index < parts.length; index++) {
      const normalized = parts[index]!.normalize('NFC');
      const matches = (await readdir(current)).filter(name => name.normalize('NFC') === normalized);
      if (!matches.length) throw Object.assign(new Error('WORLD_PACKAGE_FILE_NOT_FOUND'), { code: 'ENOENT' });
      if (matches.length !== 1) throw new Error('AMBIGUOUS_WORLD_PACKAGE_PATH');
      current = join(current, matches[0]!);
      stat = await lstat(current);
      if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
        throw new Error('INVALID_WORLD_PACKAGE_FILE');
      }
    }
    const actual = await realpath(current);
    if (!actual.startsWith(root + sep)) throw new Error('INVALID_WORLD_PACKAGE_PATH');
    return { path: actual, stat: stat! };
  }
}
