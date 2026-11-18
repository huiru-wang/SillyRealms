import type { DatabaseSync } from 'node:sqlite';
import { CredentialService, type CredentialStore } from './modules/credentials/service.js';
import { ModelService } from './modules/models/service.js';
import { PresetService } from './modules/presets/service.js';
import { SessionService } from './modules/sessions/service.js';
import { SettingsService } from './modules/settings/service.js';
import { StateService } from './modules/state/service.js';
import { WorldService } from './modules/worlds/service.js';

/** Explicit composition of the business services; storage stays inside each module. */
export function createServices(database: DatabaseSync, dataRoot: string, credentialStore?: CredentialStore) {
  const credentials = new CredentialService(dataRoot, credentialStore);
  const presets = new PresetService(database);
  const models = new ModelService(database);
  const settings = new SettingsService(database, { presets, models });
  const worlds = new WorldService(database, { presets, models }, dataRoot);
  const sessions = new SessionService(database, { worlds, presets, models });
  const state = new StateService({ worlds, sessions });
  return { credentials, presets, models, settings, worlds, sessions, state };
}

export type Services = ReturnType<typeof createServices>;
