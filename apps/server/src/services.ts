import { loadInitialData } from './infrastructure/initial-data/catalog.js';
import { RuntimeCache } from './infrastructure/cache/index.js';
import type { DatabaseSync } from 'node:sqlite';
import { CredentialService, type CredentialStore } from './modules/credentials/service.js';
import { ModelService } from './modules/models/service.js';
import { PresetService } from './modules/presets/service.js';
import { SessionService } from './modules/sessions/service.js';
import { SettingsService } from './modules/settings/service.js';
import { StateService } from './modules/state/service.js';
import { WorldService } from './modules/worlds/service.js';

/** Explicit composition of the business services; storage stays inside each module. */
export function createServices(database: DatabaseSync, dataRoot: string, credentialStore?: CredentialStore, initialData = loadInitialData()) {
  const cache = new RuntimeCache();
  const credentials = new CredentialService(dataRoot, credentialStore);
  const presets = new PresetService(database, initialData);
  const models = new ModelService(database);
  const settings = new SettingsService(database, { presets, models });
  const worlds = new WorldService(database, { presets, models, cache }, dataRoot);
  const sessions = new SessionService(database, { worlds, presets, models, cache });
  const state = new StateService({ worlds, sessions });
  return { initialWorlds: initialData.worlds, cache, credentials, presets, models, settings, worlds, sessions, state };
}

export type Services = ReturnType<typeof createServices>;
