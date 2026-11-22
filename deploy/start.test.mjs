import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../deploy.sh', import.meta.url));
const exec = promisify(execFile);
const provisionKey = ({ keyFile, credentialsDir }) =>
  exec('bash', ['-c', 'source "$1"; provision_key "$2" "$3"', '--', script, keyFile, credentialsDir]);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sr-deploy-key-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, 'data');
  await mkdir(dataRoot);
  await writeFile(join(dataRoot, 'do-not-touch.txt'), 'existing user data');
  return { root, dataRoot, keyFile: join(root, 'credential.key'), credentialsDir: join(dataRoot, 'credentials') };
}

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
