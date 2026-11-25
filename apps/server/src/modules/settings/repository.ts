import type { AppLocale } from '@sillyrealms/sdk/locale';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../../errors.js';
import type { SettingsValues } from './types.js';

export type StoredAppSettings = {
  id: 1;
  locale: AppLocale;
  cover_mosaic_density: number;
  default_reply_assist_preset_id: string | null;
  default_preset_id: string | null;
  default_api_model_config_id: string | null;
  created_at: number;
  updated_at: number;
};

/** Module-private persistence for the application settings singleton. */
export class SettingsRepository {
  constructor(private readonly db: DatabaseSync) {}

  getOptional(): StoredAppSettings | null {
    const row = this.db.prepare('SELECT * FROM app_settings WHERE id=1').get();
    if (!row) return null;
    return {
      id: 1,
      locale: row.locale as AppLocale,
      cover_mosaic_density: Number(row.cover_mosaic_density),
      default_reply_assist_preset_id: row.default_reply_assist_preset_id === null ? null : String(row.default_reply_assist_preset_id),
      default_preset_id: row.default_preset_id === null ? null : String(row.default_preset_id),
      default_api_model_config_id: row.default_api_model_config_id === null ? null : String(row.default_api_model_config_id),
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    };
  }

  get(): StoredAppSettings {
    const row = this.getOptional();
    if (!row) throw new AppError('APP_SETTINGS_MISSING');
    return row;
  }

  ensure(value: SettingsValues): StoredAppSettings {
    const now = Date.now();
    this.db.prepare('INSERT INTO app_settings(id,locale,cover_mosaic_density,default_reply_assist_preset_id,default_preset_id,default_api_model_config_id,created_at,updated_at) VALUES(1,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
      .run(value.locale, value.coverMosaicDensity, value.defaultReplyAssistPresetId, value.defaultPresetId, value.defaultApiModelConfigId, now, now);
    return this.get();
  }

  update(value: SettingsValues): StoredAppSettings {
    this.db.prepare('UPDATE app_settings SET locale=?,cover_mosaic_density=?,default_reply_assist_preset_id=?,default_preset_id=?,default_api_model_config_id=?,updated_at=? WHERE id=1')
      .run(value.locale, value.coverMosaicDensity, value.defaultReplyAssistPresetId, value.defaultPresetId, value.defaultApiModelConfigId, Date.now());
    return this.get();
  }
}
