#!/usr/bin/env node
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectWorldSource, prepareWorldSourcePackage, type WorldSourceInspection,
} from '../apps/server/src/modules/worlds/service.js';
import { assertOutsidePackage, checkWorldComponents as checkComponents, WorldCardToolError as ToolError } from './world-card-checks.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const usage = [
  'pnpm world:check <目录 | JSON | ZIP>',
  'pnpm world:pack <目录> [--out <ZIP>]',
  '相对路径以仓库根目录为准。默认输出为源码目录同级 <目录名>.zip；不会覆盖已有文件。',
].join('\n');

function argumentsFor(args: string[]) {
  const [action, ...rest] = args;
  if (rest[0] === '--') rest.shift();
  if (action !== 'check' && action !== 'pack') throw new ToolError('INVALID_ARGUMENT', usage);
  if (rest.length === 1 && ['--help', '-h'].includes(rest[0]!)) return null;
  const [input, ...options] = rest;
  if (!input || input.startsWith('-')) throw new ToolError('INVALID_ARGUMENT', usage);
  if (action === 'check' && options.length) throw new ToolError('INVALID_ARGUMENT', usage);
  if (action === 'pack' && options.length && (options.length !== 2 || options[0] !== '--out' || !options[1] || options[1].startsWith('-'))) {
    throw new ToolError('INVALID_ARGUMENT', usage);
  }
  const source = resolve(repositoryRoot, input);
  const output = action === 'pack' ? resolve(repositoryRoot, options[1] ?? source + '.zip') : undefined;
  return { action, source, output };
}
function report(action: string, input: string, inspection: WorldSourceInspection, output?: string) {
  return {
    ok: true, action, input, ...(output ? { output } : {}), name: inspection.card.data.name,
    format: inspection.format, files: inspection.packageFiles.length, components: inspection.components.length,
    checks: ['world-card', 'state-and-references', 'declared-package-resources', 'component-syntax-and-module-graph',
      ...(inspection.format === 'zip' ? ['zip-import'] : [])],
    ignoredRootEntries: inspection.ignoredRootEntries,
    limitations: [
      '未执行组件或进行浏览器试玩，也未调用模型。',
      '未下载或验证远程 URL；组件动态资源地址和 SDK 使用行为需在 SR 内检查。',
    ],
  };
}
async function main() {
  const options = argumentsFor(process.argv.slice(2));
  if (!options) { console.log(usage); return; }
  const { action, source, output } = options;
  if (action === 'check') {
    const inspection = await inspectWorldSource(source);
    checkComponents(inspection);
    console.log(JSON.stringify(report(action, source, inspection), null, 2));
    return;
  }
  if (extname(output!).toLowerCase() !== '.zip') throw new ToolError('INVALID_OUTPUT', '输出文件必须使用 .zip 扩展名');
  await assertOutsidePackage(source, output!);
  const exists = await lstat(output!).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (exists) throw new ToolError('OUTPUT_EXISTS', '输出已存在，请更换 --out 路径：' + output);
  const staged = await prepareWorldSourcePackage(source);
  try {
    checkComponents(staged.inspection);
    await mkdir(dirname(output!), { recursive: true });
    await copyFile(staged.path, output!, constants.COPYFILE_EXCL);
    console.log(JSON.stringify(report(action, source, staged.inspection, output), null, 2));
  } finally {
    await staged.cleanup();
  }
}

main().catch(error => {
  const code = error instanceof Error && 'code' in error ? String(error.code) : 'WORLD_CARD_CHECK_FAILED';
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, code, message }, null, 2));
  process.exitCode = 1;
});
