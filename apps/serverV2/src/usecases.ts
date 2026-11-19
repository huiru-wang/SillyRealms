import type { TransactionRunner } from './infrastructure/database/transaction.js';
import type { Services } from './services.js';
import type { EventHub } from './infrastructure/events/event-hub.js';
import { PiClient } from './infrastructure/pi/client.js';
import { createNarrativeUsecases } from './usecases/narrative/index.js';
import { createTestModel } from './usecases/test-model.js';
import { createModelConfigUsecases } from './usecases/model-config.js';
import { createExportPreset } from './usecases/export-preset.js';
import { createExportWorld } from './usecases/export-world.js';
import { createImportPreset } from './usecases/import-preset.js';
import { createImportWorld } from './usecases/import-world.js';
import { createInitialize } from './usecases/initialize.js';
import { createSetState } from './usecases/set-state.js';

/** Application flows are composed here; no usecase opens or retains a database connection. */
export function createUsecases({ services, transaction, events, pi = new PiClient() }: {
  services: Services; transaction: TransactionRunner; events: EventHub; pi?: PiClient;
}) {
  const { worlds, sessions, presets, settings } = services;
  return {
    narrative: createNarrativeUsecases({ ...services, events, pi }),
    testModel: createTestModel({ models: services.models, credentials: services.credentials, pi }),
    listModels: () => pi.listModels(),
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
