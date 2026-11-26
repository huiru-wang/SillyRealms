#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  inspectWorldSource, prepareWorldSourcePackage, type WorldPublication,
} from '../apps/server/src/modules/worlds/service.js';
import {
  releaseIndexLimits, validateReleaseIndex, type WorldReleaseRecord, type WorldVersionIndex,
} from '../apps/server/src/usecases/world-updates/index.js';
import {
  assertOutsidePackage, checkWorldComponents, resolvedOutputPath, WorldCardToolError as ToolError,
} from './world-card-checks.mjs';

// This file is the CLI entry. Resolve input paths from its repository, regardless of caller cwd.
const repositoryRoot = resolve(dirname(process.argv[1]!), '..');
const usage = [
  'pnpm world:release --dir <源码目录> --version <MAJOR.MINOR.PATCH> --notes <UTF-8 文件>',
  '  --artifact-url <公开 HTTPS ZIP 地址> --index <releases.json> --out <发行目录>',
  '  [--published-at <带时区 ISO 8601 时间>] [--title <版本标题>]',
  '相对路径以仓库根目录为准；输出 <发行目录>/versions/<版本>/<源码目录名>.zip。',
  '更新 --index 指定的完整版本目录；不修改作者源码，不上传文件，不覆盖已有版本或 ZIP。',
].join('\n');

type Options = {
  source: string; version: string; notes: string; artifactUrl: string; index: string; output: string;
  publishedAt: string; title?: string;
};
function argumentsFor(args: string[]): Options | null {
  if (args[0] === '--') args.shift();
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) return null;
  const required = ['--dir', '--version', '--notes', '--artifact-url', '--index', '--out'];
  const allowed = new Set([...required, '--published-at', '--title']);
  const values = new Map<string, string>();
  for (let offset = 0; offset < args.length; offset += 2) {
    const key = args[offset]!;
    const value = args[offset + 1];
    if (!allowed.has(key) || values.has(key) || !value || value.startsWith('--')) {
      throw new ToolError('INVALID_ARGUMENT', usage);
    }
    values.set(key, value);
  }
  if (required.some(key => !values.has(key))) throw new ToolError('INVALID_ARGUMENT', usage);
  return {
    source: resolve(repositoryRoot, values.get('--dir')!), version: values.get('--version')!,
    notes: resolve(repositoryRoot, values.get('--notes')!), artifactUrl: values.get('--artifact-url')!,
    index: resolve(repositoryRoot, values.get('--index')!), output: resolve(repositoryRoot, values.get('--out')!),
    publishedAt: values.get('--published-at') ?? new Date().toISOString(),
    ...(values.has('--title') ? { title: values.get('--title')! } : {}),
  };
}
function errorCode(error: unknown): string | null {
  return error instanceof Error && 'code' in error ? String(error.code) : null;
}
async function readUtf8(path: string): Promise<string> {
  const bytes = await readFile(path);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new ToolError('INVALID_UTF8', '文件必须使用有效 UTF-8 编码：' + path); }
}
async function indexText(path: string): Promise<string | null> {
  let info;
  try { info = await lstat(path); }
  catch (error) { if (errorCode(error) === 'ENOENT') return null; throw error; }
  if (!info.isFile()) throw new ToolError('INVALID_RELEASE_INDEX', '版本目录必须是普通 JSON 文件，不能使用符号链接');
  return readUtf8(path);
}
function readIndex(text: string | null, packageId: string): WorldVersionIndex {
  let value: unknown = { schema_version: 1, package_id: packageId, versions: [] };
  if (text !== null) {
    try { value = JSON.parse(text); }
    catch { throw new ToolError('INVALID_RELEASE_INDEX', '已有版本目录不是有效 JSON'); }
  }
  return validateReleaseIndex(value, packageId);
}
async function digestFile(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { sha256: hash.digest('hex'), size_bytes: (await stat(path)).size };
}

async function release(options: Options) {
  const source = await inspectWorldSource(options.source);
  if (source.format !== 'directory') throw new ToolError('INVALID_WORLD_DIRECTORY', '发行输入必须是包含 world.json 的源码目录');
  if (source.card.spec_version !== '0.2' || !source.card.data.publication) {
    throw new ToolError('WORLD_PUBLICATION_REQUIRED', '请先在 0.2 源卡中填写固定 package_id、作者与有效 publication');
  }
  const publication: WorldPublication = {
    ...source.card.data.publication,
    release: { version: options.version, published_at: options.publishedAt, notes: await readUtf8(options.notes) },
  };
  const index = await resolvedOutputPath(options.index);
  await assertOutsidePackage(options.source, index);
  await mkdir(dirname(index), { recursive: true });
  const lockPath = index + '.lock';
  const lock = await open(lockPath, 'wx').catch(error => {
    if (errorCode(error) === 'EEXIST') throw new ToolError('RELEASE_INDEX_LOCKED', '另一个发行正在使用该目录；确认无发行进程后才能移除遗留锁：' + lockPath);
    throw error;
  });
  try {
    const before = await indexText(index);
    const previous = readIndex(before, publication.package_id);
    if (previous.versions.some(item => item.version === options.version)) {
      throw new ToolError('RELEASE_VERSION_EXISTS', '版本已存在，发行文件不可覆盖，请使用新版本号：' + options.version);
    }
    const staged = await prepareWorldSourcePackage(options.source, { publication });
    try {
      checkWorldComponents(staged.inspection);
      const card = staged.inspection.card;
      const actual = card.data.publication!;
      const version = actual.release.version;
      // Use the formally validated version, never unchecked CLI text, in filesystem paths.
      const output = await resolvedOutputPath(join(options.output, 'versions', version, basename(options.source) + '.zip'));
      await assertOutsidePackage(options.source, output);
      if (output === index || output === lockPath) throw new ToolError('INVALID_OUTPUT', 'ZIP 与版本目录必须使用不同路径');
      const digest = await digestFile(staged.path);
      const record: WorldReleaseRecord = {
        version, published_at: actual.release.published_at, notes: actual.release.notes,
        spec_version: card.spec_version, ...(options.title === undefined ? {} : { title: options.title }),
        artifact: { format: 'zip', url: options.artifactUrl, ...digest },
      };
      const next = validateReleaseIndex({
        ...previous, versions: [...previous.versions, record],
      }, actual.package_id, previous);
      const text = JSON.stringify(next, null, 2) + '\n';
      if (Buffer.byteLength(text, 'utf8') > releaseIndexLimits.bytes) {
        throw new ToolError('INVALID_WORLD_RELEASE_INDEX', '格式化后的完整版本目录超过 2 MiB，不能发布');
      }
      const temporaryIndex = join(dirname(index), '.' + basename(index) + '.' + randomUUID() + '.tmp');
      let copied = false;
      let committed = false;
      try {
        await mkdir(dirname(output), { recursive: true });
        await copyFile(staged.path, output, constants.COPYFILE_EXCL).catch(error => {
          if (errorCode(error) === 'EEXIST') throw new ToolError('OUTPUT_EXISTS', '发行 ZIP 已存在，不会覆盖：' + output);
          throw error;
        });
        copied = true;
        await writeIndex(temporaryIndex, text);
        // Detect edits made by another program while this invocation was packing.
        if (await indexText(index) !== before) throw new ToolError('RELEASE_INDEX_CHANGED', '版本目录在打包期间发生变化，请检查后重试');
        await rename(temporaryIndex, index);
        committed = true;
      } finally {
        await rm(temporaryIndex, { force: true });
        if (copied && !committed) await rm(output, { force: true });
      }
      return {
        ok: true, action: 'release', name: card.data.name, packageId: actual.package_id, version,
        publishedAt: actual.release.published_at, output, index, artifact: record.artifact,
        updateUrl: actual.update_url ?? null, versions: next.versions.length,
        checks: ['world-card', 'state-and-references', 'declared-package-resources',
          'component-syntax-and-module-graph', 'zip-import', 'release-index'],
        ignoredRootEntries: staged.inspection.ignoredRootEntries,
        limitations: ['未执行组件、实际导入或试玩，也未调用模型。', '未访问远程链接或上传文件；先发布 ZIP，再发布版本目录。'],
      };
    } finally { await staged.cleanup(); }
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
async function writeIndex(path: string, text: string): Promise<void> {
  const file = await open(path, 'wx');
  try {
    await file.writeFile(text, 'utf8');
    await file.sync();
  } finally { await file.close(); }
}
async function main() {
  const options = argumentsFor(process.argv.slice(2));
  if (!options) { console.log(usage); return; }
  console.log(JSON.stringify(await release(options), null, 2));
}
main().catch(error => {
  console.error(JSON.stringify({
    ok: false, code: errorCode(error) ?? 'WORLD_RELEASE_FAILED',
    message: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
});
