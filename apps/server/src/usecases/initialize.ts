import type { TransactionRunner } from '../infrastructure/database/transaction.js';
import type { PresetService } from '../modules/presets/service.js';
import type { SettingsService } from '../modules/settings/service.js';

type Dependencies = {
  presets: Pick<PresetService, 'ensureDefault'>;
  settings: Pick<SettingsService, 'ensure'>;
  transaction: TransactionRunner;
};

/** Every startup fills missing initial records; existing content and user choices stay intact. */
export function createInitialize({ presets, settings, transaction }: Dependencies) {
  return () => transaction(() => {
    const preset = presets.ensureDefault();
    return settings.ensure({ defaultPresetId: preset.id, defaultApiModelConfigId: null });
  });
}

export type Initialize = ReturnType<typeof createInitialize>;
