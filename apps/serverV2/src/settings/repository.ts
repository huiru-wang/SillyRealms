import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../errors.js';
import type { SettingsValues } from './types.js';

export type StoredAppSettings = {
  id: 1;
  default_preset_id: string | null;
  default_api_model_config_id: string | null;
  created_at: number;
  updated_at: number;
};

/** Module-private persistence for the application settings singleton. */
export class SettingsRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(): StoredAppSettings {
    const row = this.db.prepare('SELECT * FROM app_settings WHERE id=1').get();
    if (!row) throw new AppError('APP_SETTINGS_MISSING');
    return {
      id: 1,
      default_preset_id: row.default_preset_id === null ? null : String(row.default_preset_id),
      default_api_model_config_id: row.default_api_model_config_id === null ? null : String(row.default_api_model_config_id),
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    };
  }

  update(value: SettingsValues): StoredAppSettings {
    this.db.prepare('UPDATE app_settings SET default_preset_id=?,default_api_model_config_id=?,updated_at=? WHERE id=1')
      .run(value.defaultPresetId, value.defaultApiModelConfigId, Date.now());
    return this.get();
  }
}
