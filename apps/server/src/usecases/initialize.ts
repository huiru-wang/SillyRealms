import { DEFAULT_LOCALE } from '@sillyrealms/sdk/locale';
import type { TransactionRunner } from '../infrastructure/database/transaction.js';
import { resourceError, type InitialWorld } from '../infrastructure/initial-data/catalog.js';
import type { PresetService } from '../modules/presets/service.js';
import type { SettingsService } from '../modules/settings/service.js';
import type { WorldService } from '../modules/worlds/service.js';
import type { createImportWorld } from './import-world.js';

type Dependencies = {
  presets: Pick<PresetService, 'ensureBuiltins'>;
  settings: Pick<SettingsService, 'ensure'>;
  worlds: Pick<WorldService, 'get'>;
  initialWorlds: readonly InitialWorld[];
  importWorld: ReturnType<typeof createImportWorld>;
  transaction: TransactionRunner;
};

export function createInitialize({ presets, settings, worlds, initialWorlds, importWorld, transaction }: Dependencies) {
  return async () => {
    const defaults = transaction(() => settings.ensure({
      locale: DEFAULT_LOCALE, defaultPresetId: presets.ensureBuiltins(), defaultApiModelConfigId: null,
    }));
    for (const { id, file, readBytes } of initialWorlds) {
      if (worlds.get(id)) continue;
      try {
        await importWorld({ format: 'zip', bytes: await readBytes() }, id);
      } catch (error) {
        throw resourceError('worlds/' + file + ' (' + id + ', data path worlds/' + id + ')', error);
      }
    }
    return defaults;
  };
}

export type Initialize = ReturnType<typeof createInitialize>;
