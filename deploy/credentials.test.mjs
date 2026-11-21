import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createEncryptedCredentialStore } from './credentials.mjs';
import { deploymentOptions } from './server.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sr-deploy-credentials-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keyFile = join(root, 'master.key');
  const directory = join(root, 'credentials');
  await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
  const store = await createEncryptedCredentialStore({ directory, keyFile });
  const file = reference => join(directory, createHash('sha256').update(reference).digest('hex') + '.enc');
  return { root, keyFile, directory, store, file };
}

test('credentials persist encrypted across restarts with private file permissions', async t => {
  const { store, directory, keyFile, file } = await fixture(t);
  const reference = 'v2:test:model-one';
  const secret = 'test-api-secret-完整保留';
  assert.equal(await store.get(reference), null);
  assert.equal(await store.has(reference), false);
  await store.set(reference, secret);
  assert.equal(await store.get(reference), secret);
  assert.equal(await store.has(reference), true);
  const bytes = await readFile(file(reference));
  assert.equal(bytes.includes(Buffer.from(secret)), false);
  assert.equal(bytes.includes(Buffer.from(reference)), false);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(file(reference))).mode & 0o777, 0o600);
  const restarted = await createEncryptedCredentialStore({ directory, keyFile });
  assert.equal(await restarted.get(reference), secret);
  await restarted.set(reference, secret);
  assert.notDeepEqual(await readFile(file(reference)), bytes, 'each encryption uses a fresh nonce');
  await restarted.set(reference, 'replacement-key');
  assert.equal(await store.get(reference), 'replacement-key');
  assert.deepEqual(await readdir(directory), [file(reference).split('/').at(-1)]);
  await store.delete(reference);
  await store.delete(reference);
  assert.equal(await restarted.get(reference), null);
  assert.deepEqual(await readdir(directory), []);
});

test('wrong master key and tampered ciphertext fail closed', async t => {
  const { store, root, directory, file } = await fixture(t);
  const reference = 'v2:test:tamper';
  await store.set(reference, 'test-original-key');
  const wrongKey = join(root, 'wrong.key');
  await writeFile(wrongKey, randomBytes(32), { mode: 0o600 });
  const wrongStore = await createEncryptedCredentialStore({ directory, keyFile: wrongKey });
  await assert.rejects(wrongStore.get(reference), /decryption failed/);
  await assert.rejects(wrongStore.has(reference), /decryption failed/);
  const bytes = await readFile(file(reference));
  bytes[bytes.length - 1] ^= 1;
  await writeFile(file(reference), bytes);
  await assert.rejects(store.get(reference), /decryption failed/);
});

test('copying another reference ciphertext cannot substitute its credential', async t => {
  const { store, file } = await fixture(t);
  const first = 'v2:test:first';
  const second = 'v2:test:second';
  await store.set(first, 'first-secret');
  await store.set(second, 'second-secret');
  await copyFile(file(first), file(second));
  await assert.rejects(store.get(second), /decryption failed/);
  assert.equal(await store.get(first), 'first-secret');
});

test('insecure, missing, malformed and symbolic-link master keys are rejected', async t => {
  const { directory, root, keyFile } = await fixture(t);
  await assert.rejects(createEncryptedCredentialStore({
    directory, keyFile: join(root, 'missing.key'),
  }), { code: 'ENOENT' });
  assert.deepEqual(await readdir(directory), []);
  await writeFile(keyFile, randomBytes(31));
  await assert.rejects(createEncryptedCredentialStore({ directory, keyFile }), /exactly 32 bytes/);
  await writeFile(keyFile, randomBytes(32));
  await chmod(keyFile, 0o644);
  await assert.rejects(createEncryptedCredentialStore({ directory, keyFile }), /must be private/);
  await chmod(keyFile, 0o600);
  const linkedKey = join(root, 'linked.key');
  await symlink(keyFile, linkedKey);
  await assert.rejects(createEncryptedCredentialStore({ directory, keyFile: linkedKey }));
});

test('credential directory and ciphertext symlinks are not followed', async t => {
  const { store, root, directory, keyFile, file } = await fixture(t);
  const linkedDirectory = join(root, 'linked');
  await symlink(directory, linkedDirectory);
  await assert.rejects(createEncryptedCredentialStore({
    directory: linkedDirectory, keyFile,
  }), /not a symlink/);
  const reference = 'v2:test:linked';
  const target = join(root, 'outside-secret');
  await writeFile(target, 'never-read-this', { mode: 0o600 });
  await symlink(target, file(reference));
  await assert.rejects(store.get(reference), /read failed/);
  await store.set(reference, 'new-encrypted-secret');
  assert.equal(await store.get(reference), 'new-encrypted-secret');
  assert.equal(await readFile(target, 'utf8'), 'never-read-this');
});

test('readers see complete credentials during repeated atomic replacements', async t => {
  const { store, directory } = await fixture(t);
  const reference = 'v2:test:atomic';
  await store.set(reference, 'old-value');
  await Promise.all([
    (async () => {
      for (let i = 0; i < 12; i++) await store.set(reference, i % 2 ? 'new-value' : 'old-value');
    })(),
    (async () => {
      for (let i = 0; i < 30; i++) assert.ok(['old-value', 'new-value'].includes(await store.get(reference)));
    })(),
  ]);
  assert.equal((await readdir(directory)).length, 1);
});

test('failed publication cleans temporary ciphertext without reporting success', async t => {
  const { store, directory, file } = await fixture(t);
  const reference = 'v2:test:blocked';
  await mkdir(file(reference));
  await assert.rejects(store.set(reference, 'test-secret'));
  assert.deepEqual(await readdir(directory), [file(reference).split('/').at(-1)]);
});

test('invalid credentials are rejected without writing files', async t => {
  const { store, directory } = await fixture(t);
  for (const value of ['', 'contains\nnewline', 'contains\0nul']) {
    await assert.rejects(store.set('v2:test:valid', value), /Invalid credential/);
    await assert.rejects(store.set(value, 'test-secret'), /Invalid credential reference/);
  }
  assert.deepEqual(await readdir(directory), []);
});

test('deployment options inject the encrypted adapter without starting a server', async t => {
  const { root, keyFile } = await fixture(t);
  const dataRoot = join(root, 'data');
  const options = await deploymentOptions({
    SERVER_DATA_ROOT: dataRoot,
    SERVER_CREDENTIAL_KEY_FILE: keyFile,
    SERVER_PORT: '3002',
    SERVER_WEB_ORIGIN: 'http://sr.example.test',
    SERVER_STAGE_ORIGIN: 'http://sr.example.test:8081',
    SERVER_DEBUG: 'true',
  });
  assert.equal(options.dataRoot, dataRoot);
  assert.equal(options.port, 3002);
  assert.equal(options.webOrigin, 'http://sr.example.test');
  assert.equal(options.stageOrigin, 'http://sr.example.test:8081');
  assert.equal(options.debug, true);
  await options.credentialStore.set('v2:test:injected', 'test-injected-secret');
  assert.equal(await options.credentialStore.get('v2:test:injected'), 'test-injected-secret');
  assert.equal((await readdir(join(dataRoot, 'credentials'))).length, 1);
  await assert.rejects(deploymentOptions({ SERVER_DATA_ROOT: dataRoot }), /SERVER_CREDENTIAL_KEY_FILE is required/);
});
