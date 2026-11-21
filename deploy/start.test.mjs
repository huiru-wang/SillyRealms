import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { atomicWrite, provisionKey, publishStatic, switchCurrent, verifyNginx, waitForNginx } from './start.mjs';

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

test('atomicWrite replaces complete content and requested permissions without temporary leftovers', async t => {
  const { root } = await fixture(t);
  const file = join(root, 'managed.conf');
  await atomicWrite(file, 'first', 0o600);
  await atomicWrite(file, 'second', 0o644);
  assert.equal(await readFile(file, 'utf8'), 'second');
  assert.equal((await stat(file)).mode & 0o777, 0o644);
  assert.equal((await readdir(root)).filter(name => name.includes('.tmp-')).length, 0);
  const blocked = join(root, 'blocked');
  await mkdir(blocked);
  await assert.rejects(atomicWrite(blocked, 'must-fail'));
  assert.equal((await lstat(blocked)).isDirectory(), true);
  assert.equal((await readdir(root)).filter(name => name.includes('.tmp-')).length, 0);
});

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

test('master key is generated once with correct size and permissions and reused unchanged', async t => {
  const config = await fixture(t);
  await provisionKey(config);
  const first = await readFile(config.keyFile);
  assert.equal(first.length, 32);
  assert.equal((await stat(config.keyFile)).mode & 0o777, 0o600);
  await provisionKey(config);
  assert.deepEqual(await readFile(config.keyFile), first);
  assert.equal(await readFile(join(config.dataRoot, 'do-not-touch.txt'), 'utf8'), 'existing user data');
});

test('existing encrypted credentials prevent replacement of a missing master key', async t => {
  const config = await fixture(t);
  await mkdir(config.credentialsDir, { mode: 0o700 });
  const encrypted = randomBytes(64);
  await writeFile(join(config.credentialsDir, 'existing.enc'), encrypted, { mode: 0o600 });
  await assert.rejects(provisionKey(config), /主密钥缺失/);
  await assert.rejects(lstat(config.keyFile), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(config.credentialsDir, 'existing.enc')), encrypted);
});

test('insecure, malformed and symlink existing master keys are rejected without alteration', async t => {
  const config = await fixture(t);
  const key = randomBytes(32);
  await writeFile(config.keyFile, key, { mode: 0o644 });
  await assert.rejects(provisionKey(config), /32 字节普通文件/);
  assert.deepEqual(await readFile(config.keyFile), key);
  await chmod(config.keyFile, 0o600);
  await writeFile(config.keyFile, randomBytes(31));
  await assert.rejects(provisionKey(config), /32 字节普通文件/);
  assert.equal((await readFile(config.keyFile)).length, 31);
  await rm(config.keyFile);
  const external = join(config.root, 'external.key');
  await writeFile(external, key, { mode: 0o600 });
  await symlink(external, config.keyFile);
  await assert.rejects(provisionKey(config), /32 字节普通文件/);
  assert.deepEqual(await readFile(external), key);
});

test('Nginx HTTPS verification uses the configured CA while retaining URL hostname and certificate checks', async () => {
  const { normalizeConfig } = await import('./config.mjs');
  const config = normalizeConfig({
    webOrigin: 'https://fanto.example.com', stageOrigin: 'https://fanto.example.com:8443',
    webTlsCert: '/etc/nginx/ssl/origin.pem', webTlsKey: '/etc/nginx/ssl/origin.key',
    stageTlsCert: '/etc/nginx/ssl/origin.pem', stageTlsKey: '/etc/nginx/ssl/origin.key',
    tlsCaFile: '/etc/nginx/ssl/origin-ca.pem',
  }, { projectDir: '/root/SillyRealms' });
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    const url = new URL(args.at(-1));
    return { stdout: args.includes('--write-out') ? '404' :
      url.pathname === '/api/v1/runtime/config' ? JSON.stringify({ data: { stage: { origin: config.stageOrigin } } }) :
      '<html>ok</html>' };
  };
  await verifyNginx(config, run);
  assert.equal(calls.length, 8);
  for (const { command, args } of calls) {
    assert.equal(command, 'curl');
    assert.equal(args[args.indexOf('--cacert') + 1], config.tlsCaFile);
    assert.equal(new URL(args.at(-1)).hostname, 'fanto.example.com');
    assert.ok(args.includes('--connect-to'));
    assert.ok(!args.includes('-k') && !args.includes('--insecure'));
  }
  const failed = new Error('curl certificate verification failed');
  await assert.rejects(verifyNginx(config, async () => { throw failed; }), error => error === failed);
  calls.length = 0;
  await verifyNginx({ ...config, tlsCaFile: undefined }, run);
  for (const { args } of calls) assert.ok(!args.includes('--cacert') && !args.includes('--insecure'));
});


function nginxReadinessFixture() {
  const web = { origin: 'http://sr.example.com', hostname: 'sr.example.com', port: 80, protocol: 'http:' };
  const stage = { origin: 'http://sr.example.com:8081', hostname: 'sr.example.com', port: 8081, protocol: 'http:' };
  const config = { web, stage, stageOrigin: stage.origin };
  const respond = args => ({ stdout: args.includes('--write-out') ? '404' :
    new URL(args.at(-1)).pathname === '/api/v1/runtime/config' ?
      JSON.stringify({ data: { stage: { origin: stage.origin } } }) : '<html>ready</html>' });
  return { config, respond };
}

test('Nginx readiness retries the complete read-only validation after a transient reload failure', async () => {
  const { config, respond } = nginxReadinessFixture();
  const calls = [];
  await waitForNginx(config, async (command, args) => {
    calls.push({ command, args });
    if (calls.length === 1) throw new Error('curl: (22) HTTP 502 from old worker');
    return respond(args);
  }, undefined, { attempts: 3, intervalMs: 0 });
  assert.equal(calls.length, 9);
  assert.equal(calls.filter(call => new URL(call.args.at(-1)).pathname === '/api/v1/runtime/config' &&
    !call.args.includes('--write-out')).length, 2);
  assert.ok(calls.every(call => call.command === 'curl'));
});

test('Nginx readiness stops at its attempt limit and preserves the final verification error', async () => {
  const { config } = nginxReadinessFixture();
  const errors = [new Error('first 502'), new Error('second 502'), new Error('last 502')];
  let attempts = 0;
  await assert.rejects(waitForNginx(config, async () => {
    throw errors[attempts++];
  }, undefined, { attempts: 3, intervalMs: 0 }), error => error === errors[2]);
  assert.equal(attempts, 3);
});

test('Nginx readiness respects cancellation before checking and while waiting to retry', async () => {
  const { config } = nginxReadinessFixture();
  const alreadyAborted = new AbortController();
  const reason = new Error('deployment cancelled');
  alreadyAborted.abort(reason);
  let calls = 0;
  await assert.rejects(waitForNginx(config, async () => {
    calls++; throw new Error('unreachable');
  }, alreadyAborted.signal), error => error === reason);
  assert.equal(calls, 0);

  const controller = new AbortController();
  const pending = waitForNginx(config, async () => {
    calls++;
    setTimeout(() => controller.abort(), 5);
    throw new Error('old worker');
  }, controller.signal, { attempts: 10, intervalMs: 10000 });
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(calls, 1);
});
