import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { AppError } from '../../errors.js';
import { MacKeychainStore, type CredentialStore } from './keychain.js';

export type { CredentialStore } from './keychain.js';
export type CredentialStatus = 'configured' | 'missing' | 'unavailable';

export class CredentialService {
  readonly #prefix: string;
  constructor(dataRoot: string, private readonly store: CredentialStore = new MacKeychainStore()) {
    this.#prefix = 'v2:' + createHash('sha256').update(resolve(dataRoot)).digest('hex').slice(0, 24) + ':';
  }
  referenceFor(modelId: string): string { return this.#prefix + modelId; }
  owns(reference: string): boolean { return reference.startsWith(this.#prefix); }

  async status(reference: string): Promise<CredentialStatus> {
    if (!this.owns(reference)) return 'missing';
    try { return await this.store.has(reference) ? 'configured' : 'missing'; }
    catch { return 'unavailable'; }
  }
  async get(reference: string) {
    if (!this.owns(reference)) return null;
    try { return await this.store.get(reference); }
    catch { throw new AppError('CREDENTIAL_STORE_ERROR'); }
  }
  async set(reference: string, secret: string) {
    if (!this.owns(reference)) throw new AppError('INVALID_REQUEST');
    try { await this.store.set(reference, secret); }
    catch { throw new AppError('CREDENTIAL_WRITE_FAILED'); }
  }
  async delete(reference: string) {
    if (!this.owns(reference)) return;
    try { await this.store.delete(reference); }
    catch { throw new AppError('CREDENTIAL_STORE_ERROR'); }
  }
}
