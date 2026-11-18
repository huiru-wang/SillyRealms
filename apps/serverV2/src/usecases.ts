import type { TransactionRunner } from './database/transaction.js';
import type { Services } from './services.js';
import { createModelConfigUsecases } from './usecases/model-config.js';
import { createExportPreset } from './usecases/export-preset.js';
import { createExportWorld } from './usecases/export-world.js';
import { createImportPreset } from './usecases/import-preset.js';
import { createImportWorld } from './usecases/import-world.js';
import { createInitialize } from './usecases/initialize.js';
import { createSetState } from './usecases/set-state.js';

/** Application flows are composed here; no usecase opens or retains a database connection. */
export function createUsecases({ services, transaction }: { services: Services; transaction: TransactionRunner }) {
  const { worlds, sessions, presets, settings } = services;
  return {
    modelConfigs: createModelConfigUsecases(services),
    initialize: createInitialize({ presets, settings, transaction }),
    setState: createSetState({ worlds, sessions }),
    importWorld: createImportWorld({ worlds, settings }),
    exportWorld: createExportWorld({ worlds }),
    importPreset: createImportPreset({ presets }),
    exportPreset: createExportPreset({ presets }),
  };
}

export type Usecases = ReturnType<typeof createUsecases>;
