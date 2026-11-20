import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

export interface CredentialStore {
  get(reference: string): Promise<string | null>;
  has(reference: string): Promise<boolean>;
  set(reference: string, secret: string): Promise<void>;
  delete(reference: string): Promise<void>;
}

const execute = promisify(execFile);
const service = 'SillyRealms.server-v2.api-model';

/** Credentials travel over stdin, never command arguments, logs or the business database. */
export class MacKeychainStore implements CredentialStore {
  private checkPlatform() {
    if (process.platform !== 'darwin') throw new Error('Credential store unsupported');
  }

  private async find(reference: string, secret: boolean): Promise<string | null> {
    this.checkPlatform();
    try {
      const result = await execute('/usr/bin/security', [
        'find-generic-password', '-s', service, '-a', reference, ...(secret ? ['-w'] : []),
      ], { timeout: 15000, maxBuffer: 65536 });
      return result.stdout.replace(/\r?\n$/, '');
    } catch (error) {
      if ((error as { code?: number }).code === 44) return null;
      throw new Error('Credential store unavailable');
    }
  }

  get(reference: string) { return this.find(reference, true); }
  async has(reference: string) { return await this.find(reference, false) !== null; }

  async set(reference: string, secret: string) {
    this.checkPlatform();
    if (!secret || /[\r\n\0]/.test(secret) || /[\r\n\0]/.test(reference)) throw new Error('Invalid credential');
    const quote = (value: string) => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
      const timeout = setTimeout(() => child.kill(), 15000);
      let diagnostic = '';
      child.stderr.on('data', chunk => {
        diagnostic += String(chunk);
        if (diagnostic.length > 65536) child.kill();
      });
      child.stdin.on('error', () => { /* close/error settles the operation without exposing command bytes */ });
      child.on('error', () => { clearTimeout(timeout); reject(new Error('Credential write failed')); });
      child.on('close', code => {
        clearTimeout(timeout);
        if (code === 0 && !/error|failed/i.test(diagnostic)) resolve(); else reject(new Error('Credential write failed'));
      });
      child.stdin.end('add-generic-password -U -s ' + quote(service) + ' -a ' + quote(reference) + ' -w ' + quote(secret) + '\n');
    });
    if (await this.get(reference) !== secret) throw new Error('Credential verification failed');
  }

  async delete(reference: string) {
    this.checkPlatform();
    try {
      await execute('/usr/bin/security', ['delete-generic-password', '-s', service, '-a', reference], { timeout: 15000 });
    } catch (error) {
      if ((error as { code?: number }).code !== 44) throw new Error('Credential cleanup failed');
    }
  }
}
