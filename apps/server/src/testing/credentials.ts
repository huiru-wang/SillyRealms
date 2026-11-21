import type { CredentialStore } from '../modules/credentials/service.js';

/** Function tests only: never read or modify the machine's real credential store. */
export function memoryCredentials(): CredentialStore {
  const values = new Map<string, string>();
  return {
    get: async reference => values.get(reference) ?? null,
    has: async reference => values.has(reference),
    set: async (reference, value) => { values.set(reference, value); },
    delete: async reference => { values.delete(reference); },
  };
}
