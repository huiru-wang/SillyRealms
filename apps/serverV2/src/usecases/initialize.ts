import type { TransactionRunner } from '../infrastructure/database/transaction.js';
import type { PresetService } from '../modules/presets/service.js';
import type { SettingsService } from '../modules/settings/service.js';

type Dependencies = {
  presets: Pick<PresetService, 'ensureDefault'>;
  settings: Pick<SettingsService, 'getOptional' | 'ensure'>;
  transaction: TransactionRunner;
};

/** A settings singleton marks completed initialization; restarting never repairs user choices. */
export function createInitialize({ presets, settings, transaction }: Dependencies) {
  return () => transaction(() => {
    const existing = settings.getOptional();
    if (existing) return existing;
    const preset = presets.ensureDefault();
    return settings.ensure({ defaultPresetId: preset.id, defaultApiModelConfigId: null });
  });
}

export type Initialize = ReturnType<typeof createInitialize>;
