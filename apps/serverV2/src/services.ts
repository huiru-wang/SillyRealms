import type { DatabaseSync } from 'node:sqlite';
import { ModelService } from './models/service.js';
import { PresetService } from './presets/service.js';
import { SessionService } from './sessions/service.js';
import { SettingsService } from './settings/service.js';
import { StateService } from './state/service.js';
import { WorldService } from './worlds/service.js';

/** Explicit composition of the business services; storage stays inside each module. */
export function createServices(database: DatabaseSync, dataRoot: string) {
  const presets = new PresetService(database);
  const models = new ModelService(database);
  const settings = new SettingsService(database, { presets, models });
  const worlds = new WorldService(database, { presets, models }, dataRoot);
  const sessions = new SessionService(database, { worlds, presets, models });
  const state = new StateService({ worlds, sessions });
  return { presets, models, settings, worlds, sessions, state };
}

export type Services = ReturnType<typeof createServices>;
