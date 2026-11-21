import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

function validText(value) {
  return typeof value === 'string' && value.length > 0 && !/[\r\n\0]/.test(value);
}

async function readPrivateFile(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) {
      throw new Error('Credential file must be private and owned by the service user');
    }
    return await file.readFile();
  } finally {
    await file.close();
  }
}

/** Linux deployment adapter; the application still owns references and model write ordering. */
class EncryptedCredentialStore {
  #directory;
  #key;

  constructor(directory, key) {
    this.#directory = directory;
    this.#key = key;
  }

  #path(reference) {
    if (!validText(reference)) throw new Error('Invalid credential reference');
    return join(this.#directory, createHash('sha256').update(reference).digest('hex') + '.enc');
  }

  async get(reference) {
    let bytes;
    try {
      bytes = await readPrivateFile(this.#path(reference));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error('Credential read failed');
    }
    try {
      // Binary envelope: version (1), nonce (12), GCM tag (16), ciphertext.
      if (bytes[0] !== 1 || bytes.length <= 29) throw new Error('Invalid credential envelope');
      const decipher = createDecipheriv('aes-256-gcm', this.#key, bytes.subarray(1, 13));
      decipher.setAAD(Buffer.from(reference, 'utf8'));
      decipher.setAuthTag(bytes.subarray(13, 29));
      return Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('Credential decryption failed');
    }
  }

  async has(reference) {
    return await this.get(reference) !== null;
  }

  async set(reference, secret) {
    const destination = this.#path(reference);
    if (!validText(secret)) throw new Error('Invalid credential');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    cipher.setAAD(Buffer.from(reference, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const bytes = Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]);
    const temporary = destination + '.' + randomBytes(12).toString('hex') + '.tmp';
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, destination);
    } finally {
      await unlink(temporary).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  async delete(reference) {
    await unlink(this.#path(reference)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

/**
 * The 32-byte master key is provisioned once outside the data directory by start.sh.
 * Missing, insecure or invalid keys fail closed; this never generates or replaces a key.
 * @returns {Promise<import('../apps/server/src/modules/credentials/service.js').CredentialStore>}
 */
export async function createEncryptedCredentialStore({ directory, keyFile }) {
  if (!directory || !keyFile) throw new Error('Credential directory and master key file are required');
  const key = await readPrivateFile(keyFile);
  if (key.length !== 32) throw new Error('Credential master key must contain exactly 32 bytes');
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.uid !== process.getuid()) {
    throw new Error('Credential directory must be owned by the service user and not a symlink');
  }
  await chmod(root, 0o700);
  return new EncryptedCredentialStore(root, key);
}
