import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { validatePackagePath } from '@sillyrealms/sdk/assets';
import { AppError } from '../../errors.js';

export type WorldPaths = { root: string; source: string; package: string };
export type OriginalFormat = 'json' | 'zip';
export type WorldOriginal = { format: OriginalFormat; bytes: Uint8Array };
export type PackageFile = { path: string; stat: Stats };
export type ReleaseIndexSnapshot = Readonly<{ text: string; mtimeMs: number }>;
export type WorldDownload = { body: ReadableStream<Uint8Array>; filename: string; size: number };
const WORLD_RELEASE_INDEX_LIMIT = 2 * 1024 * 1024;
export const WORLD_JSON_LIMIT = 10 * 1024 * 1024;
export const WORLD_ZIP_LIMIT = 256 * 1024 * 1024;
const sourceLimits: Record<OriginalFormat, number> = { json: WORLD_JSON_LIMIT, zip: WORLD_ZIP_LIMIT };
export type ImportFileStage = { worldId: string; root: string; format: OriginalFormat; published: boolean };
const worldWrites = new Map<string, Promise<void>>();

/** Generated IDs are UUIDs; explicit IDs must be safe on case-insensitive filesystems too. */
export function assertWorldId(id: string): void {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id)) throw new AppError('INVALID_WORLD_ID');
}

export function getWorldPaths(dataRoot: string, worldId: string): WorldPaths {
  assertWorldId(worldId);
  const root = resolve(dataRoot, 'worlds', worldId);
  return { root, source: join(root, 'source'), package: join(root, 'package') };
}

/** The export name comes from the current world name, never an original upload filename. */
export function exportFilename(worldName: string): string {
  if (typeof worldName !== 'string') throw new AppError('INVALID_WORLD_NAME');
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

type InvalidFileCode = 'INVALID_WORLD_ORIGINAL' | 'INVALID_WORLD_PACKAGE_FILE' | 'WORLD_RELEASE_INDEX_READ_FAILED';
type MissingFileCode = 'WORLD_ORIGINAL_NOT_FOUND' | 'WORLD_PACKAGE_FILE_NOT_FOUND' | 'WORLD_RELEASE_INDEX_READ_FAILED';

async function openVerified(path: string, expected: Stats, invalidCode: InvalidFileCode, missingCode: MissingFileCode) {
  let file: FileHandle | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino) throw new AppError(invalidCode);
    return { file, stat };
  } catch (error) {
    await file?.close();
    if (missing(error)) throw new AppError(missingCode);
    if (error instanceof Error && 'code' in error && error.code === 'ELOOP') throw new AppError(invalidCode);
    throw error;
  }
}

function download(file: FileHandle, stat: Stats, filename: string, signal?: AbortSignal, cleanup?: () => Promise<void>): WorldDownload {
  const stream = file.createReadStream({ autoClose: true, signal, highWaterMark: 64 * 1024 });
  if (cleanup) stream.once('close', () => { void cleanup().catch(() => {}); });
  // Bound buffering in bytes; cancellation, errors and EOF close the file handle.
  const body = Readable.toWeb(stream, {
    strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength },
  }) as ReadableStream<Uint8Array>;
  return { body, filename, size: stat.size };
}

function packageSegments(path: string): string[] {
  if (typeof path !== 'string' || !path || /[\\:\u0000-\u001f\u007f]/.test(path)) throw new AppError('INVALID_WORLD_PACKAGE_PATH');
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || Buffer.byteLength(part, 'utf8') > 255)) {
    throw new AppError('INVALID_WORLD_PACKAGE_PATH');
  }
  return parts;
}

async function withWorldWrite<T>(key: string, write: () => Promise<T>): Promise<T> {
  const previous = worldWrites.get(key) ?? Promise.resolve();
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  worldWrites.set(key, waiting);
  await previous;
  try {
    return await write();
  } finally {
    release();
    if (worldWrites.get(key) === waiting) worldWrites.delete(key);
  }
}

export async function resolvePackagePath(root: string, relativePath: string): Promise<PackageFile> {
    const parts = packageSegments(relativePath);
    try {
      const rootStat = await lstat(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new AppError('INVALID_WORLD_DIRECTORY');
      root = await realpath(root);
      let current = root;
      let stat: Stats | undefined;
      for (let index = 0; index < parts.length; index++) {
        const normalized = parts[index]!.normalize('NFC');
        const matches = (await readdir(current)).filter(name => name.normalize('NFC') === normalized);
        if (!matches.length) throw new AppError('WORLD_PACKAGE_FILE_NOT_FOUND');
        if (matches.length !== 1) throw new AppError('AMBIGUOUS_WORLD_PACKAGE_PATH');
        current = join(current, matches[0]!);
        stat = await lstat(current);
        if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
          throw new AppError('INVALID_WORLD_PACKAGE_FILE');
        }
      }
      const actual = await realpath(current);
      if (!actual.startsWith(root + sep)) throw new AppError('INVALID_WORLD_PACKAGE_PATH');
      return { path: actual, stat: stat! };
    } catch (error) {
      if (missing(error)) throw new AppError('WORLD_PACKAGE_FILE_NOT_FOUND');
      throw error;
    }
  }


/** Author folders may also contain notes; only these three roots enter a world package. */
export const packageRoots = new Set(['world.json', 'components', 'assets']);

export async function listPackageDirectory(root: string, ignoreOtherRootEntries = false): Promise<string[]> {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new AppError('INVALID_WORLD_DIRECTORY');
  const files: string[] = [], names = new Set<string>();
  let count = 0;
  const walk = async (prefix: string): Promise<void> => {
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
      if (!prefix && ignoreOtherRootEntries && !packageRoots.has(entry.name)) continue;
      if (++count > 10000) throw new AppError('INVALID_WORLD_PACKAGE', '包内条目超过 10000');
      const name = prefix ? prefix + '/' + entry.name : entry.name;
      try { validatePackagePath(name); }
      catch { throw new AppError('INVALID_WORLD_PACKAGE_PATH', name); }
      const normalized = name.normalize('NFC').toLowerCase();
      if (names.has(normalized)) throw new AppError('AMBIGUOUS_WORLD_PACKAGE_PATH', name);
      names.add(normalized);
      if (entry.isSymbolicLink()) throw new AppError('INVALID_WORLD_PACKAGE_FILE', name);
      if (entry.isDirectory()) {
        if (!['assets', 'components'].includes(name) && !name.startsWith('assets/') && !name.startsWith('components/')) {
          throw new AppError('INVALID_WORLD_PACKAGE_FILE', name);
        }
        await walk(name);
      } else if (entry.isFile()) {
        if (name !== 'world.json' && !name.startsWith('assets/') && !name.startsWith('components/')) {
          throw new AppError('INVALID_WORLD_PACKAGE_FILE', name);
        }
        files.push(name);
      } else throw new AppError('INVALID_WORLD_PACKAGE_FILE', name);
    }
  };
  await walk('');
  return files.sort();
}

/** Module-private filesystem operations; callers coordinate persistence through WorldService. */
export class WorldFileStore {
  constructor(private readonly dataRoot: string) {}

  paths(worldId: string): WorldPaths {
    return getWorldPaths(this.dataRoot, worldId);
  }

  private async directory(worldId: string, leaf?: 'source' | 'package', create = false): Promise<string> {
    assertWorldId(worldId);
    if (create) await mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
    // The configured data root may itself be a system alias (for example /tmp on macOS).
    let directory = await realpath(this.dataRoot);
    for (const segment of ['worlds', worldId, ...(leaf ? [leaf] : [])]) {
      directory = join(directory, segment);
      if (create) {
        await mkdir(directory, { mode: 0o700 }).catch(error => {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        });
      }
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AppError('INVALID_WORLD_DIRECTORY');
    }
    return directory;
  }

  private async originalAt(source: string): Promise<{ format: OriginalFormat; path: string; stat: Stats } | null> {
    let found: { format: OriginalFormat; path: string; stat: Stats } | null = null;
    for (const format of ['json', 'zip'] as const) {
      const path = join(source, 'original.' + format);
      const stat = await lstat(path).catch(error => { if (missing(error)) return null; throw error; });
      if (!stat) continue;
      if (!stat.isFile() || stat.isSymbolicLink()) throw new AppError('INVALID_WORLD_ORIGINAL');
      if (found) throw new AppError('AMBIGUOUS_WORLD_ORIGINAL');
      found = { format, path, stat };
    }
    return found;
  }

  async saveOriginal(worldId: string, format: OriginalFormat, bytes: Uint8Array, guard?: () => void): Promise<void> {
    if (format !== 'json' && format !== 'zip') throw new AppError('INVALID_WORLD_ORIGINAL_FORMAT');
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > sourceLimits[format]) {
      throw new AppError('INVALID_WORLD_ORIGINAL_SIZE');
    }
    // Enqueue before mkdir so deletion cannot finish ahead of an already-accepted write.
    await withWorldWrite(this.paths(worldId).root, async () => {
      guard?.();
      const source = await this.directory(worldId, 'source', true);
      const current = await this.originalAt(source);
      // Switching formats is a future import policy, not a partially atomic two-file replacement.
      if (current && current.format !== format) throw new AppError('WORLD_SOURCE_FORMAT_CONFLICT');
      const temporary = join(source, '.original-' + randomUUID());
      try {
        await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
        guard?.();
        await rename(temporary, join(source, 'original.' + format));
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }

  /** Raw validated remote bytes; interpretation remains in the update usecase. */
  async readReleaseIndex(worldId: string): Promise<ReleaseIndexSnapshot | null> {
    let file: FileHandle | undefined;
    try {
      const path = join(await this.directory(worldId), 'releases.json');
      const expected = await lstat(path);
      if (!expected.isFile() || expected.isSymbolicLink() || expected.size > WORLD_RELEASE_INDEX_LIMIT) {
        throw new AppError('WORLD_RELEASE_INDEX_READ_FAILED');
      }
      const opened = await openVerified(path, expected, 'WORLD_RELEASE_INDEX_READ_FAILED', 'WORLD_RELEASE_INDEX_READ_FAILED');
      file = opened.file;
      if (opened.stat.size > WORLD_RELEASE_INDEX_LIMIT) throw new AppError('WORLD_RELEASE_INDEX_READ_FAILED');
      const bytes = await file.readFile();
      if (bytes.byteLength > WORLD_RELEASE_INDEX_LIMIT) throw new AppError('WORLD_RELEASE_INDEX_READ_FAILED');
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), mtimeMs: opened.stat.mtimeMs };
    } catch (error) {
      if (missing(error)) return null;
      if (error instanceof AppError) throw error;
      throw new AppError('WORLD_RELEASE_INDEX_READ_FAILED');
    } finally { await file?.close(); }
  }

  /** Never creates a world directory, so late checks cannot resurrect a deleted world. */
  async saveReleaseIndex(worldId: string, text: string, isCurrent: () => boolean): Promise<ReleaseIndexSnapshot | null> {
    if (typeof text !== 'string' || !text || Buffer.byteLength(text, 'utf8') > WORLD_RELEASE_INDEX_LIMIT) {
      throw new AppError('WORLD_RELEASE_INDEX_WRITE_FAILED');
    }
    return withWorldWrite(this.paths(worldId).root, async () => {
      if (!isCurrent()) return null;
      const root = await this.directory(worldId).catch(error => { if (missing(error)) return null; throw error; });
      if (root === null) return null;
      const temporary = join(root, '.releases-' + randomUUID());
      try {
        await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
        const stat = await lstat(temporary);
        if (!isCurrent()) return null;
        await rename(temporary, join(root, 'releases.json'));
        return { text, mtimeMs: stat.mtimeMs };
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError('WORLD_RELEASE_INDEX_WRITE_FAILED');
      } finally { await rm(temporary, { force: true }); }
    });
  }

  async remove(worldId: string): Promise<boolean> {
    return withWorldWrite(this.paths(worldId).root, async () => {
      const root = await this.directory(worldId).catch(error => { if (missing(error)) return null; throw error; });
      if (root === null) return false;
      // Checked parents and root must be real directories. rm unlinks inner symlinks without following them.
      await rm(root, { recursive: true, force: true });
      return true;
    });
  }

  private async stagingRoot(create = false): Promise<string> {
    if (create) await mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
    const root = join(await realpath(this.dataRoot), 'staging');
    if (create) await mkdir(root, { mode: 0o700 }).catch(error => {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    });
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AppError('INVALID_WORLD_DIRECTORY');
    return root;
  }

  async createTemporaryDirectory(kind: 'import' | 'export'): Promise<string> {
    return mkdtemp(join(await this.stagingRoot(true), 'world-' + kind + '-'));
  }

  async removeTemporaryDirectory(directory: string): Promise<void> {
    let root: string;
    try { root = await this.stagingRoot(); }
    catch (error) { if (missing(error)) return; throw error; }
    if (dirname(directory) !== root || !/^world-(?:import|export)-[A-Za-z0-9]+$/.test(basename(directory))) {
      throw new AppError('INVALID_WORLD_DIRECTORY');
    }
    const stat = await lstat(directory).catch(error => { if (missing(error)) return null; throw error; });
    if (!stat) return;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AppError('INVALID_WORLD_DIRECTORY');
    await rm(directory, { recursive: true, force: true });
  }

  async stageImport(worldId: string, format: OriginalFormat, bytes: Uint8Array): Promise<ImportFileStage> {
    assertWorldId(worldId);
    if (format !== 'json' && format !== 'zip') throw new AppError('INVALID_WORLD_ORIGINAL_FORMAT');
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new AppError('INVALID_WORLD_ORIGINAL_SIZE');
    if (bytes.byteLength > sourceLimits[format]) throw new AppError('PAYLOAD_TOO_LARGE');
    const root = await this.createTemporaryDirectory('import');
    try {
      await mkdir(join(root, 'source'), { mode: 0o700 });
      await mkdir(join(root, 'package'), { mode: 0o700 });
      await writeFile(join(root, 'source', 'original.' + format), bytes, { flag: 'wx', mode: 0o600 });
      return { worldId, root, format, published: false };
    } catch (error) {
      try { await this.removeTemporaryDirectory(root); }
      catch { throw new AppError('WORLD_IMPORT_CLEANUP_FAILED'); }
      throw error;
    }
  }

  async publishImport(stage: ImportFileStage): Promise<void> {
    await withWorldWrite(this.paths(stage.worldId).root, async () => {
      if (stage.published) throw new AppError('RESOURCE_CONFLICT');
      const staging = await this.stagingRoot();
      if (dirname(stage.root) !== staging) throw new AppError('INVALID_WORLD_DIRECTORY');
      const stat = await lstat(stage.root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AppError('INVALID_WORLD_DIRECTORY');
      const root = await realpath(this.dataRoot);
      const worlds = join(root, 'worlds');
      await mkdir(worlds, { mode: 0o700 }).catch(error => {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      });
      const parent = await lstat(worlds);
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new AppError('INVALID_WORLD_DIRECTORY');
      const target = join(worlds, stage.worldId);
      const existing = await lstat(target).catch(error => { if (missing(error)) return null; throw error; });
      if (existing) throw new AppError('RESOURCE_CONFLICT');
      await rename(stage.root, target);
      stage.root = target;
      stage.published = true;
    });
  }

  /**
   * Replace only source/package while retaining the world root and releases.json inode.
   * Both callbacks are synchronous; commit owns the world repository's CAS transaction.
   */
  async replaceImport<T>(
    stage: ImportFileStage,
    check: (snapshot: ReleaseIndexSnapshot | null) => void,
    commit: (snapshot: ReleaseIndexSnapshot | null) => T,
  ): Promise<T> {
    return withWorldWrite(this.paths(stage.worldId).root, async () => {
      const movedOld: ('source' | 'package')[] = [];
      const movedNew: ('source' | 'package')[] = [];
      let root: string | undefined;
      let backup: string | undefined;
      try {
        if (stage.published || dirname(stage.root) !== await this.stagingRoot()) throw new AppError('INVALID_WORLD_DIRECTORY');
        const staged = await lstat(stage.root);
        if (!staged.isDirectory() || staged.isSymbolicLink()) throw new AppError('INVALID_WORLD_DIRECTORY');
        root = await this.directory(stage.worldId);
        for (const leaf of ['source', 'package'] as const) {
          await this.directory(stage.worldId, leaf);
          const stat = await lstat(join(stage.root, leaf));
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AppError('INVALID_WORLD_DIRECTORY');
        }
        const snapshot = await this.readReleaseIndex(stage.worldId);
        check(snapshot);
        backup = join(stage.root, 'previous');
        await mkdir(backup, { mode: 0o700 });
        // An asynchronous file operation can invalidate the caller's permit/task token.
        check(snapshot);
        for (const leaf of ['source', 'package'] as const) {
          await rename(join(root, leaf), join(backup, leaf));
          movedOld.push(leaf);
          await rename(join(stage.root, leaf), join(root, leaf));
          movedNew.push(leaf);
        }
        const result = commit(snapshot);
        // After DB commit, cleanup cannot turn success into a false rollback.
        try { await this.removeTemporaryDirectory(stage.root); }
        catch { console.warn('WORLD_UPDATE_BACKUP_CLEANUP_FAILED', { worldId: stage.worldId }); }
        return result;
      } catch (error) {
        try {
          if (root && backup) {
            for (const leaf of [...movedNew].reverse()) await rename(join(root, leaf), join(stage.root, leaf));
            for (const leaf of [...movedOld].reverse()) await rename(join(backup, leaf), join(root, leaf));
          }
        } catch {
          // Keep the private backup for recovery; a caller must not discard this stage.
          throw new AppError('WORLD_UPDATE_REPLACE_FAILED', '文件恢复失败，已保留临时备份');
        }
        try { await this.removeTemporaryDirectory(stage.root); }
        catch { console.warn('WORLD_UPDATE_STAGE_CLEANUP_FAILED', { worldId: stage.worldId }); }
        throw error;
      }
    });
  }

  async discardImport(stage: ImportFileStage): Promise<void> {
    if (stage.published) await this.remove(stage.worldId);
    else await this.removeTemporaryDirectory(stage.root);
  }

  async listPackageFiles(worldId: string): Promise<string[]> {
    const root = await this.directory(worldId, 'package').catch(error => { if (missing(error)) return null; throw error; });
    return root === null ? [] : listPackageDirectory(root);
  }

  async openExport(path: string, filename: string, cleanup: () => Promise<void>, signal?: AbortSignal): Promise<WorldDownload> {
    const stat = await lstat(path);
    const { file, stat: current } = await openVerified(path, stat, 'INVALID_WORLD_PACKAGE_FILE', 'WORLD_PACKAGE_FILE_NOT_FOUND');
    try { return download(file, current, filename, signal, cleanup); }
    catch (error) { await file.close(); throw error; }
  }

  private async openOriginalFile(worldId: string): Promise<{ file: FileHandle; stat: Stats; format: OriginalFormat } | null> {
    const source = await this.directory(worldId, 'source').catch(error => { if (missing(error)) return null; throw error; });
    if (source === null) return null;
    const original = await this.originalAt(source);
    if (!original) return null;
    const { file, stat } = await openVerified(original.path, original.stat, 'INVALID_WORLD_ORIGINAL', 'WORLD_ORIGINAL_NOT_FOUND');
    if (stat.size === 0 || stat.size > sourceLimits[original.format]) {
      await file.close();
      throw new AppError('INVALID_WORLD_ORIGINAL_SIZE');
    }
    return { file, stat, format: original.format };
  }

  async readOriginal(worldId: string): Promise<WorldOriginal | null> {
    const original = await this.openOriginalFile(worldId);
    if (!original) return null;
    try {
      return { format: original.format, bytes: await original.file.readFile() };
    } finally {
      await original.file.close();
    }
  }

  async openOriginal(worldId: string, signal?: AbortSignal): Promise<WorldDownload | null> {
    const original = await this.openOriginalFile(worldId);
    if (!original) return null;
    try {
      return download(original.file, original.stat, 'original.' + original.format, signal);
    } catch (error) {
      await original.file.close();
      throw error;
    }
  }

  async resolvePackageFile(worldId: string, relativePath: string): Promise<PackageFile> {
    try {
      return await resolvePackagePath(await this.directory(worldId, 'package'), relativePath);
    } catch (error) {
      if (missing(error)) throw new AppError('WORLD_PACKAGE_FILE_NOT_FOUND');
      throw error;
    }
  }

  async openPackageFile(worldId: string, relativePath: string, signal?: AbortSignal): Promise<WorldDownload> {
    const resolved = await this.resolvePackageFile(worldId, relativePath);
    const { file, stat } = await openVerified(resolved.path, resolved.stat, 'INVALID_WORLD_PACKAGE_FILE', 'WORLD_PACKAGE_FILE_NOT_FOUND');
    try {
      return download(file, stat, basename(resolved.path), signal);
    } catch (error) {
      await file.close();
      throw error;
    }
  }
}
