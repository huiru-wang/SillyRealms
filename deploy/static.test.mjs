import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { publishStatic, switchCurrent } from './static.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sr-deploy-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectDir = join(root, 'project');
  const staticRoot = join(root, 'public');
  const web = join(projectDir, 'apps/web/dist');
  const stage = join(projectDir, 'apps/web/dist-preview');
  const dataRoot = join(projectDir, 'data');
  const configDir = join(root, 'config');
  for (const path of [join(web, 'assets'), join(stage, 'assets'), dataRoot, configDir]) {
    await mkdir(path, { recursive: true });
  }
  await writeFile(join(web, 'index.html'), '<html>web-v1</html>');
  await writeFile(join(web, 'assets/app.js'), 'web app');
  await writeFile(join(stage, 'frame.html'), '<html>stage</html>');
  await writeFile(join(stage, 'world-component.html'), '<html>preview</html>');
  await writeFile(join(stage, 'assets/frame.js'), 'stage app');
  await writeFile(join(dataRoot, 'do-not-touch.txt'), 'existing user data');
  return {
    root, projectDir, staticRoot, web, stage, dataRoot,
    keyFile: join(configDir, 'credential.key'),
    credentialsDir: join(dataRoot, 'credentials'),
  };
}

test('identical static builds reuse one release while preserving source data and unrelated files', async t => {
  const { projectDir, staticRoot, web, dataRoot } = await fixture(t);
  const first = await publishStatic(projectDir, staticRoot);
  await writeFile(join(staticRoot, 'operator-notes.txt'), 'keep this');
  const second = await publishStatic(projectDir, staticRoot);
  assert.equal(second, first);
  assert.equal((await readdir(join(staticRoot, 'releases'))).length, 1);
  assert.equal(await readFile(join(staticRoot, 'operator-notes.txt'), 'utf8'), 'keep this');
  assert.equal(await readFile(join(dataRoot, 'do-not-touch.txt'), 'utf8'), 'existing user data');
  assert.equal(await readFile(join(web, 'index.html'), 'utf8'), '<html>web-v1</html>');
  assert.equal((await stat(first)).mode & 0o777, 0o755);
  assert.equal((await stat(join(first, 'web/index.html'))).mode & 0o777, 0o644);
  await assert.rejects(lstat(join(first, 'data')), { code: 'ENOENT' });
});

test('changed build gets a distinct release and current can be switched and restored', async t => {
  const { projectDir, staticRoot, web } = await fixture(t);
  const first = await publishStatic(projectDir, staticRoot);
  await switchCurrent(staticRoot, first);
  await writeFile(join(web, 'index.html'), '<html>web-v2</html>');
  const second = await publishStatic(projectDir, staticRoot);
  assert.notEqual(second, first);
  await switchCurrent(staticRoot, second);
  assert.equal((await lstat(join(staticRoot, 'current'))).isSymbolicLink(), true);
  assert.equal(await readFile(join(staticRoot, 'current/web/index.html'), 'utf8'), '<html>web-v2</html>');
  assert.equal(await readFile(join(first, 'web/index.html'), 'utf8'), '<html>web-v1</html>');
  await switchCurrent(staticRoot, first);
  assert.equal(await readFile(join(staticRoot, 'current/web/index.html'), 'utf8'), '<html>web-v1</html>');
  await switchCurrent(staticRoot, null);
  await switchCurrent(staticRoot, null);
  await assert.rejects(lstat(join(staticRoot, 'current')), { code: 'ENOENT' });
  assert.equal((await readdir(join(staticRoot, 'releases'))).length, 2);
  assert.equal((await readdir(staticRoot)).filter(name => name.includes('.tmp-')).length, 0);
});

test('publication refuses an unmanaged destination and a non-symlink current', async t => {
  const { projectDir, staticRoot } = await fixture(t);
  await mkdir(staticRoot);
  await writeFile(join(staticRoot, 'unrelated.txt'), 'keep existing');
  await assert.rejects(publishStatic(projectDir, staticRoot), /非本脚本管理/);
  assert.deepEqual(await readdir(staticRoot), ['unrelated.txt']);
  await writeFile(join(staticRoot, 'current'), 'keep current');
  await assert.rejects(switchCurrent(staticRoot, '/arbitrary/target'), /不是发布符号链接/);
  assert.equal(await readFile(join(staticRoot, 'current'), 'utf8'), 'keep current');
});

test('publication rejects symlink files and symlink build roots', async t => {
  const { projectDir, staticRoot, web, dataRoot, root } = await fixture(t);
  await symlink(join(dataRoot, 'do-not-touch.txt'), join(web, 'leak.txt'));
  await assert.rejects(publishStatic(projectDir, staticRoot), /符号链接|普通目录/);
  await rm(join(web, 'leak.txt'));
  const moved = join(root, 'outside-build');
  await rename(web, moved);
  await symlink(moved, web);
  await assert.rejects(publishStatic(projectDir, staticRoot), /符号链接|普通目录/);
  assert.equal(await readFile(join(dataRoot, 'do-not-touch.txt'), 'utf8'), 'existing user data');
});

test('publication rejects symlink static roots, managed markers and release containers', async t => {
  const { projectDir, staticRoot, root } = await fixture(t);
  const external = join(root, 'external');
  await mkdir(external);
  await symlink(external, staticRoot);
  await assert.rejects(publishStatic(projectDir, staticRoot), /普通目录|符号链接/);
  assert.deepEqual(await readdir(external), []);
  await rm(staticRoot);
  await mkdir(staticRoot);
  const marker = join(external, 'marker');
  await writeFile(marker, 'SillyRealms static releases\n');
  await symlink(marker, join(staticRoot, '.sillyrealms-deploy'));
  await assert.rejects(publishStatic(projectDir, staticRoot), /标记|符号链接|普通文件/);
  await rm(join(staticRoot, '.sillyrealms-deploy'));
  await writeFile(join(staticRoot, '.sillyrealms-deploy'), 'SillyRealms static releases\n');
  await symlink(external, join(staticRoot, 'releases'));
  await assert.rejects(publishStatic(projectDir, staticRoot), /普通目录|符号链接/);
  assert.deepEqual(await readdir(external), ['marker']);
});

test('a changed or symlinked existing content-addressed release is never reused', async t => {
  const { projectDir, staticRoot, root } = await fixture(t);
  const release = await publishStatic(projectDir, staticRoot);
  await writeFile(join(release, 'web/index.html'), 'changed outside deployment');
  await assert.rejects(publishStatic(projectDir, staticRoot), /内容被修改/);
  await writeFile(join(release, 'web/index.html'), '<html>web-v1</html>');
  const moved = join(root, 'moved-release');
  await rename(release, moved);
  await symlink(moved, release);
  await assert.rejects(publishStatic(projectDir, staticRoot), /普通目录|符号链接/);
  assert.equal(await readFile(join(moved, 'web/index.html'), 'utf8'), '<html>web-v1</html>');
});

