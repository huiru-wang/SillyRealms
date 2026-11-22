import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { updateMain } from './update.mjs';

const exec = promisify(execFile);
const git = async (directory, ...args) => (await exec('git', ['-C', directory, ...args], {
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
})).stdout.trim();

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sr-deploy-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git'), seed = join(root, 'seed'), project = join(root, 'project');
  await exec('git', ['init', '--bare', origin]);
  await exec('git', ['init', '-b', 'main', seed]);
  await git(seed, 'config', 'user.name', 'Deploy test');
  await git(seed, 'config', 'user.email', 'deploy-test@example.invalid');
  await mkdir(join(seed, 'deploy'));
  await copyFile(new URL('./update.mjs', import.meta.url), join(seed, 'deploy/update.mjs'));
  await copyFile(new URL('../deploy.sh', import.meta.url), join(seed, 'deploy.sh'));
  await writeFile(join(seed, '.gitignore'), '/data/\n.env\n');
  await writeFile(join(seed, 'source.txt'), 'first version');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'initial');
  await git(seed, 'remote', 'add', 'origin', origin);
  await git(seed, 'push', '-u', 'origin', 'main');
  await exec('git', ['clone', '--branch', 'main', origin, project]);
  await git(project, 'config', 'user.name', 'Deploy test');
  await git(project, 'config', 'user.email', 'deploy-test@example.invalid');
  const initial = await git(project, 'rev-parse', 'HEAD');
  async function publish(path = 'source.txt', content = 'latest version', force = false) {
    await writeFile(join(seed, path), content);
    await git(seed, 'add', ...(force ? ['--force'] : []), '--', path);
    await git(seed, 'commit', '-m', 'remote update');
    await git(seed, 'push', 'origin', 'main');
    return git(seed, 'rev-parse', 'HEAD');
  }
  return { root, seed, project, origin, initial, publish };
}

test('updates exactly to origin/main and is repeatable without changing ignored data or untracked notes', async t => {
  const { project, initial, publish } = await fixture(t);
  await mkdir(join(project, 'data'));
  await writeFile(join(project, 'data/database.sqlite'), 'keep database');
  await writeFile(join(project, 'operator-notes.txt'), 'keep notes');
  await writeFile(join(project, '.env'), 'keep configuration');
  const revision = await publish();
  assert.deepEqual(await updateMain(project), { previous: initial, revision });
  assert.equal(await readFile(join(project, 'source.txt'), 'utf8'), 'latest version');
  assert.deepEqual(await updateMain(project), { previous: revision, revision });
  assert.equal(await readFile(join(project, 'data/database.sqlite'), 'utf8'), 'keep database');
  assert.equal(await readFile(join(project, '.env'), 'utf8'), 'keep configuration');
  assert.equal(await readFile(join(project, 'operator-notes.txt'), 'utf8'), 'keep notes');
});

for (const staged of [false, true]) {
  test('refuses ' + (staged ? 'staged' : 'unstaged') + ' tracked changes without moving HEAD', async t => {
    const { project, initial, publish } = await fixture(t);
    await publish();
    await writeFile(join(project, 'source.txt'), 'local edit');
    if (staged) await git(project, 'add', 'source.txt');
    await assert.rejects(updateMain(project), /未提交/);
    assert.equal(await git(project, 'rev-parse', 'HEAD'), initial);
    assert.equal(await readFile(join(project, 'source.txt'), 'utf8'), 'local edit');
    assert.equal(await git(project, 'rev-parse', 'origin/main'), initial);
  });
}

test('refuses another branch, a detached HEAD and an unfinished Git operation', async t => {
  const { project, initial, publish } = await fixture(t);
  await publish();
  await git(project, 'switch', '-c', 'work');
  await assert.rejects(updateMain(project), /main 分支/);
  await git(project, 'checkout', '--detach', initial);
  await assert.rejects(updateMain(project), /main 分支|symbolic-ref/);
  await git(project, 'switch', 'main');
  await writeFile(join(project, '.git/MERGE_HEAD'), initial + '\n');
  await assert.rejects(updateMain(project), /未完成的 Git 操作/);
  assert.equal(await git(project, 'rev-parse', 'HEAD'), initial);
  assert.equal(await git(project, 'rev-parse', 'origin/main'), initial);
});

for (const diverged of [false, true]) {
  test('refuses ' + (diverged ? 'diverged main' : 'unpushed local commits') + ' without discarding commits', async t => {
    const { project, publish } = await fixture(t);
    await writeFile(join(project, 'local.txt'), 'keep local commit');
    await git(project, 'add', 'local.txt');
    await git(project, 'commit', '-m', 'local work');
    const local = await git(project, 'rev-parse', 'HEAD');
    if (diverged) await publish();
    await assert.rejects(updateMain(project), /未推送提交|分叉/);
    assert.equal(await git(project, 'rev-parse', 'HEAD'), local);
    assert.equal(await readFile(join(project, 'local.txt'), 'utf8'), 'keep local commit');
  });
}

test('refuses rewritten remote history without discarding the deployed commit', async t => {
  const { seed, project, initial } = await fixture(t);
  await git(seed, 'checkout', '--orphan', 'replacement');
  await git(seed, 'commit', '-m', 'replacement history');
  await git(seed, 'push', '--force', 'origin', 'HEAD:main');
  await assert.rejects(updateMain(project), /non-fast-forward|未推送提交|分叉/);
  assert.equal(await git(project, 'rev-parse', 'HEAD'), initial);
  assert.equal(await readFile(join(project, 'source.txt'), 'utf8'), 'first version');
});

for (const path of ['operator-notes.txt', '.env']) {
  test('refuses a remote tracked file colliding with local ' + path, async t => {
    const { project, initial, publish } = await fixture(t);
    await writeFile(join(project, path), 'must survive');
    await publish(path, 'remote contents', path === '.env');
    await assert.rejects(updateMain(project), /overwritten|覆盖/);
    assert.equal(await git(project, 'rev-parse', 'HEAD'), initial);
    assert.equal(await readFile(join(project, path), 'utf8'), 'must survive');
  });
}

test('fetch failure exits before the deployment handoff', async t => {
  const { root, project, initial } = await fixture(t);
  await git(project, 'remote', 'set-url', 'origin', join(root, 'missing.git'));
  await assert.rejects(exec('bash', ['-c', 'source ./deploy.sh; update_and_deploy'], { cwd: project }), error => {
    assert.match(error.stderr, /fetch 失败/);
    assert.doesNotMatch(error.stdout, /old deployment/);
    return true;
  });
  assert.equal(await git(project, 'rev-parse', 'HEAD'), initial);
});

test('handoff executes the fetched deploy.sh at the exact remote revision', async t => {
  const { project, publish } = await fixture(t);
  const revision = await publish('deploy.sh', 'deploy() { echo "new deployment $(git rev-parse HEAD)"; }\n');
  const { stdout } = await exec('bash', ['-c', 'source ./deploy.sh; update_and_deploy'], { cwd: project });
  assert.ok(stdout.trim().endsWith('new deployment ' + revision));
});

test('help and invalid arguments leave the clone untouched', async t => {
  const { project, initial, publish } = await fixture(t);
  await publish();
  const script = join(project, 'deploy.sh');
  const { stdout } = await exec('bash', [script, '--help']);
  assert.match(stdout, /WEB_ORIGIN/);
  for (const args of [['--unknown'], ['--check', '--unknown']]) {
    await assert.rejects(exec('bash', [script, ...args]), /用法/);
  }
  assert.equal(await git(project, 'rev-parse', 'HEAD'), initial);
  assert.equal(await git(project, 'rev-parse', 'origin/main'), initial);
});

test('requires a repository root and an origin remote', async t => {
  const { root, project, initial } = await fixture(t);
  await assert.rejects(updateMain(root), /Git 克隆/);
  await assert.rejects(updateMain(join(project, 'deploy')), /仓库根目录/);
  await git(project, 'remote', 'remove', 'origin');
  await assert.rejects(updateMain(project), /origin/);
  assert.equal(await git(project, 'rev-parse', 'HEAD'), initial);
});
