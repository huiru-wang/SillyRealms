import { ErrorCodes } from '../../common/error-codes.js';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile, execFileSync } from 'node:child_process';

export interface CredentialStore {
  set(id: string, key: string): Promise<void>;
  get(id: string): Promise<string | null>;
  deleteSync(id: string): void;
}
const exec = promisify(execFile);
const service = 'SillyRealms.api-model';

/** macOS Keychain. Secrets enter the security process through stdin, not process arguments. */
export class MacKeychainStore implements CredentialStore {
  constructor(private readonly keychainPath?: string) {}
  async set(id: string, key: string): Promise<void> {
    if (process.platform !== 'darwin') throw new Error(ErrorCodes.CREDENTIAL_STORE_UNSUPPORTED);
    if (!key || /[\r\n\0]/.test(key)) throw new Error(ErrorCodes.INVALID_API_KEY);
    const quote = (s: string) => `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
    const command = `add-generic-password -U -s ${quote(service)} -a ${quote(id)} -w ${quote(key)}${this.keychainPath ? ` ${quote(this.keychainPath)}` : ''}\n`;
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.setEncoding('utf8'); child.stderr.on('data', s => { err += s; });
      child.on('error', () => reject(new Error(ErrorCodes.CREDENTIAL_STORE_ERROR)));
      child.on('close', code => code === 0 && !/error|failed/i.test(err) ? resolve() : reject(new Error(ErrorCodes.CREDENTIAL_STORE_ERROR)));
      child.stdin.end(command);
    });
    if (await this.get(id) !== key) throw new Error(ErrorCodes.CREDENTIAL_STORE_ERROR);
  }
  async get(id: string): Promise<string | null> {
    if (process.platform !== 'darwin') throw new Error(ErrorCodes.CREDENTIAL_STORE_UNSUPPORTED);
    try { return (await exec('/usr/bin/security', ['find-generic-password', '-s', service, '-a', id, '-w', ...(this.keychainPath ? [this.keychainPath] : [])])).stdout.replace(/\r?\n$/, ''); }
    catch (err) { if ((err as { code?: number }).code === 44) return null; throw new Error(ErrorCodes.CREDENTIAL_STORE_ERROR); }
  }
  deleteSync(id: string): void {
    if (process.platform !== 'darwin') throw new Error(ErrorCodes.CREDENTIAL_STORE_UNSUPPORTED);
    try { execFileSync('/usr/bin/security', ['delete-generic-password', '-s', service, '-a', id, ...(this.keychainPath ? [this.keychainPath] : [])], { stdio: 'ignore', timeout: 10_000 }); }
    catch (err) { if ((err as { status?: number }).status !== 44) throw new Error(ErrorCodes.CREDENTIAL_STORE_ERROR); }
  }
}
