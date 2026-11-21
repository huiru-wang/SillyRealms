import type { TransactionRunner } from './infrastructure/database/transaction.js';
import type { Services } from './services.js';
import type { EventHub } from './infrastructure/events/event-hub.js';
import { PiClient } from './infrastructure/pi/client.js';
import type { ModelClient } from './infrastructure/model/client.js';
import { createNarrativeUsecases } from './usecases/narrative/index.js';
import { createTestModel } from './usecases/test-model.js';
import { createModelConfigUsecases } from './usecases/model-config.js';
import { createDeletePreset } from './usecases/delete-preset.js';
import { createDeleteWorld } from './usecases/delete-world.js';
import { createExportPreset } from './usecases/export-preset.js';
import { createExportWorld } from './usecases/export-world.js';
import { createImportPreset } from './usecases/import-preset.js';
import { createImportWorld } from './usecases/import-world.js';
import { createInitialize } from './usecases/initialize.js';
import { createSetState } from './usecases/set-state.js';
import { createAppendEntry } from './usecases/append-entry.js';
import { createSessionUsecase } from './usecases/create-session.js';

/** Application flows are composed here; no usecase opens or retains a database connection. */
export function createUsecases({ services, transaction, events, modelClient = new PiClient() }: {
  services: Services; transaction: TransactionRunner; events: EventHub; modelClient?: ModelClient;
}) {
  const { worlds, sessions, presets, settings } = services;
  return {
    createSession: createSessionUsecase({ worlds, sessions, state: services.state, transaction, events }),
    narrative: createNarrativeUsecases({ ...services, events, modelClient, transaction }),
    testModel: createTestModel({ models: services.models, credentials: services.credentials, modelClient }),
    listProviders: () => modelClient.listProviders(),
    modelConfigs: createModelConfigUsecases(services),
    initialize: createInitialize({ presets, settings, transaction }),
    setState: createSetState({ worlds, sessions, state: services.state, transaction, events, cache: services.cache }),
    appendEntry: createAppendEntry({ sessions, state: services.state, transaction, events }),
    deleteWorld: createDeleteWorld({ worlds, sessions, transaction }),
    importWorld: createImportWorld({ worlds, settings }),
    exportWorld: createExportWorld({ worlds }),
    importPreset: createImportPreset({ presets }),
    deletePreset: createDeletePreset(services, transaction),
    exportPreset: createExportPreset({ presets }),
  };
}

export type Usecases = ReturnType<typeof createUsecases>;
