import type { TransactionRunner } from './infrastructure/database/transaction.js';
import type { Services } from './services.js';
import type { EventHub } from './infrastructure/events/event-hub.js';
import { PiClient } from './infrastructure/pi/client.js';
import type { ModelClient } from './infrastructure/model/client.js';
import { createReplyAssist } from './usecases/reply-assist/index.js';
import { createNarrativeUsecases } from './usecases/narrative/index.js';
import { createTestModel } from './usecases/test-model.js';
import { createModelConfigUsecases } from './usecases/model-config.js';
import { createDeletePreset } from './usecases/delete-preset.js';
import { createDeleteWorld } from './usecases/delete-world.js';
import { createExportWorld } from './usecases/export-world.js';
import { createImportWorld } from './usecases/import-world.js';
import { createInitialize } from './usecases/initialize.js';
import { createStateUsecase } from './usecases/state.js';
import { createAppendEntry } from './usecases/append-entry.js';
import { createWorldUpdates } from './usecases/world-updates/index.js';
import { createSessionUsecase } from './usecases/create-session.js';

/** Application flows are composed here; no usecase opens or retains a database connection. */
export function createUsecases({ services, transaction, events, modelClient = new PiClient() }: {
  services: Services; transaction: TransactionRunner; events: EventHub; modelClient?: ModelClient;
}) {
  const { worlds, sessions, presets, settings } = services;
  const importWorld = createImportWorld({ worlds, settings });
  const worldUpdates = createWorldUpdates({ worlds, sessions, cache: services.cache, events });
  return {
    worldUpdates,
    createSession: createSessionUsecase({ worlds, sessions, state: services.state, transaction, events }),
    replyAssist: createReplyAssist({ ...services, modelClient, events }),
    narrative: createNarrativeUsecases({ ...services, events, modelClient, transaction }),
    testModel: createTestModel({ models: services.models, credentials: services.credentials, modelClient }),
    listProviders: () => modelClient.listProviders(),
    modelConfigs: createModelConfigUsecases(services),
    initialize: createInitialize({ presets, settings, worlds, initialWorlds: services.initialWorlds, importWorld, transaction }),
    state: createStateUsecase({ worlds, sessions, state: services.state, transaction, events, cache: services.cache }),
    appendEntry: createAppendEntry({ sessions, state: services.state, transaction, events }),
    deleteWorld: createDeleteWorld({ worlds, sessions, transaction, onWorldDeleted: worldUpdates.cancelForWorld }),
    importWorld,
    exportWorld: createExportWorld({ worlds }),
    deletePreset: createDeletePreset(services, transaction),
  };
}

export type Usecases = ReturnType<typeof createUsecases>;
