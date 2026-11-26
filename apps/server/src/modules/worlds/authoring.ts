import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppError } from '../../errors.js';
import type { WorldPublication } from './types.js';
import { parseCard, parseCardBytes } from './parser.js';
import type { WorldCard } from './validation.js';
import { readComponents, validateAssets } from './assets.js';
import {
  WorldFileStore, listPackageDirectory, packageRoots, resolvePackagePath,
  WORLD_JSON_LIMIT, WORLD_ZIP_LIMIT,
} from './files.js';
import { readImportPackage, writeWorldPackageArchive, packageFileLimit, WORLD_EXPANDED_LIMIT } from './archive.js';

export type WorldSourceInspection = {
  format: 'directory' | 'json' | 'zip';
  card: WorldCard;
  components: { id: string; component: string }[];
  packageFiles: string[];
  ignoredRootEntries: string[];
};
export type PreparedWorldSourcePackage = {
  path: string;
  inspection: WorldSourceInspection;
  cleanup: () => Promise<void>;
};

async function componentSources(card: WorldCard, root: string | null) {
  const result = await readComponents(card.data.components ?? [], path => {
    if (root === null) throw new AppError('INVALID_WORLD_CARD', '包内组件需要 ZIP 或源码目录');
    return resolvePackagePath(root, path);
  });
  const error = Object.entries(result.errors)[0];
  if (error) throw new AppError('INVALID_WORLD_CARD', '组件 ' + error[0] + ': ' + error[1]);
  return result.items;
}

async function inspectDirectory(root: string, format: 'directory' | 'zip'): Promise<WorldSourceInspection> {
  const packageFiles = await listPackageDirectory(root, format === 'directory');
  let size = 0;
  for (const name of packageFiles) {
    const file = await resolvePackagePath(root, name);
    if (file.stat.size > packageFileLimit(name)) throw new AppError('INVALID_WORLD_PACKAGE', '文件超过大小限制：' + name);
    size += file.stat.size;
    if (size > WORLD_EXPANDED_LIMIT) throw new AppError('INVALID_WORLD_PACKAGE', '包内容超过 1 GiB');
  }
  const manifest = await resolvePackagePath(root, 'world.json');
  const card = parseCardBytes(await readFile(manifest.path));
  await validateAssets(card, path => resolvePackagePath(root, path));
  return {
    format, card, components: await componentSources(card, root), packageFiles,
    ignoredRootEntries: format === 'directory' ? (await readdir(root)).filter(name => !packageRoots.has(name)).sort() : [],
  };
}

/** Offline checks use only source files and disposable OS-temp directories, never application data. */
export async function inspectWorldSource(source: string): Promise<WorldSourceInspection> {
  const stat = await lstat(source);
  if (stat.isSymbolicLink()) throw new AppError('INVALID_WORLD_ORIGINAL', '输入不能是符号链接');
  if (stat.isDirectory()) return inspectDirectory(source, 'directory');
  if (!stat.isFile()) throw new AppError('INVALID_WORLD_ORIGINAL', '输入必须是目录、JSON 或 ZIP 文件');
  const extension = extname(source).toLowerCase();
  if (extension !== '.json' && extension !== '.zip') throw new AppError('INVALID_WORLD_ORIGINAL_FORMAT');
  if (!stat.size || stat.size > (extension === '.json' ? WORLD_JSON_LIMIT : WORLD_ZIP_LIMIT)) {
    throw new AppError('INVALID_WORLD_ORIGINAL_SIZE');
  }
  const bytes = await readFile(source);
  if (extension === '.json') {
    if (bytes.byteLength > WORLD_JSON_LIMIT) throw new AppError('INVALID_WORLD_ORIGINAL_SIZE');
    const card = parseCardBytes(bytes);
    await validateAssets(card, null);
    return { format: 'json', card, components: await componentSources(card, null), packageFiles: [], ignoredRootEntries: [] };
  }
  const temporary = await mkdtemp(join(tmpdir(), 'sr-world-check-'));
  try {
    const files = new WorldFileStore(temporary);
    const stage = await files.stageImport('author-check', 'zip', bytes);
    await readImportPackage(stage);
    return await inspectDirectory(join(stage.root, 'package'), 'zip');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Return a verified staged ZIP; the caller publishes it only after its extra component checks pass. */
export async function prepareWorldSourcePackage(source: string, options: { publication?: WorldPublication } = {}): Promise<PreparedWorldSourcePackage> {
  const inspection = await inspectWorldSource(source);
  if (inspection.format !== 'directory') throw new AppError('INVALID_WORLD_DIRECTORY', '打包输入必须是包含 world.json 的源码目录');
  const card = options.publication === undefined ? inspection.card : parseCard({
    ...inspection.card, data: { ...inspection.card.data, publication: options.publication },
  });
  const temporary = await mkdtemp(join(tmpdir(), 'sr-world-pack-'));
  const cleanup = () => rm(temporary, { recursive: true, force: true });
  try {
    const path = await writeWorldPackageArchive(
      temporary, inspection.packageFiles.filter(name => name !== 'world.json'), card,
      name => resolvePackagePath(source, name),
    );
    const packaged = await inspectWorldSource(path);
    return { path, inspection: { ...packaged, ignoredRootEntries: inspection.ignoredRootEntries }, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
