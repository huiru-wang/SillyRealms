import { execFile } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function git(projectDir, args) {
  try {
    const result = await execFileAsync('git', ['-C', projectDir, ...args], {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return result.stdout.trim();
  } catch (error) {
    throw new Error('Git ' + args[0] + ' 失败：' + (error.stderr?.trim() || error.message), { cause: error });
  }
}

async function assertCleanMain(projectDir) {
  if (await git(projectDir, ['symbolic-ref', '--quiet', '--short', 'HEAD']) !== 'main') {
    throw new Error('部署目录必须位于 main 分支；请先处理当前分支。');
  }
  if (await git(projectDir, ['status', '--porcelain', '--untracked-files=no'])) {
    throw new Error('部署目录存在未提交的已跟踪文件改动；请先提交或人工处理，脚本不会覆盖。');
  }
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    const path = await git(projectDir, ['rev-parse', '--git-path', name]);
    try { await access(resolve(projectDir, path)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error('部署目录存在未完成的 Git 操作：' + name + '；请先人工处理。');
  }
}

/** Update only by fast-forward; never stash, reset, clean or overwrite ignored runtime files. */
export async function updateMain(directory) {
  const projectDir = await realpath(directory);
  let gitRoot;
  try { gitRoot = await git(projectDir, ['rev-parse', '--show-toplevel']); }
  catch { throw new Error('部署目录必须是包含 origin 的 Git 克隆；请先按 deploy/README.md 准备仓库。'); }
  if (await realpath(gitRoot) !== projectDir) {
    throw new Error('部署目录必须是 Git 仓库根目录。');
  }
  await assertCleanMain(projectDir);
  await git(projectDir, ['remote', 'get-url', 'origin']);
  const previous = await git(projectDir, ['rev-parse', 'HEAD']);
  // Read origin/main explicitly, independent of local pull/upstream configuration.
  await git(projectDir, ['fetch', '--no-tags', 'origin', 'refs/heads/main:refs/remotes/origin/main']);
  const revision = await git(projectDir, ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}']);
  try { await git(projectDir, ['merge-base', '--is-ancestor', previous, revision]); }
  catch { throw new Error('本地 main 存在未推送提交或已与 origin/main 分叉；停止部署，请先人工处理。'); }
  await assertCleanMain(projectDir);
  if (await git(projectDir, ['rev-parse', 'HEAD']) !== previous) {
    throw new Error('更新期间本地 HEAD 已变化；停止部署，请重试。');
  }
  await git(projectDir, ['-c', 'merge.autoStash=false', 'merge', '--ff-only', '--no-edit', '--no-overwrite-ignore', revision]);
  await assertCleanMain(projectDir);
  if (await git(projectDir, ['rev-parse', 'HEAD']) !== revision) {
    throw new Error('更新后的 HEAD 与本次拉取的 origin/main 不一致；停止部署。');
  }
  return { previous, revision };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) {
    console.error('[SR deploy] 用法：node deploy/update.mjs <仓库目录>');
    process.exitCode = 1;
  } else {
    updateMain(process.argv[2]).then(({ previous, revision }) => {
      console.error('[SR deploy] origin/main：' + previous.slice(0, 12) + ' → ' + revision.slice(0, 12));
      console.log(revision);
    }).catch(error => {
      console.error('[SR deploy] ' + error.message);
      process.exitCode = 1;
    });
  }
}
