import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { transaction } from '../database/connection.js';
import { assertNarrativePreset } from '../presets/repository.js';

const patchSchema = z.object({
  default_preset_id: z.string().trim().min(1).nullable().optional(),
  default_api_model_config_id: z.string().trim().min(1).nullable().optional(),
}).strict().refine(value => Object.values(value).some(item => item !== undefined), '应用默认设置更新不能为空');

export type SettingsPatch = z.input<typeof patchSchema>;
export type AppSettings = {
  id: 1;
  default_preset_id: string | null;
  default_api_model_config_id: string | null;
  created_at: number;
  updated_at: number;
};

export class SettingsRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(): AppSettings {
    const row = this.db.prepare('SELECT * FROM app_settings WHERE id=1').get();
    if (!row) throw new Error('APP_SETTINGS_MISSING');
    return {
      id: 1,
      default_preset_id: row.default_preset_id === null ? null : String(row.default_preset_id),
      default_api_model_config_id: row.default_api_model_config_id === null ? null : String(row.default_api_model_config_id),
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    };
  }

  update(input: SettingsPatch): AppSettings {
    const patch = patchSchema.parse(input);
    return transaction(this.db, () => {
      const current = this.get();
      const presetId = patch.default_preset_id === undefined ? current.default_preset_id : patch.default_preset_id;
      const modelId = patch.default_api_model_config_id === undefined ? current.default_api_model_config_id : patch.default_api_model_config_id;
      if (presetId !== null) assertNarrativePreset(this.db, presetId);
      if (modelId !== null && !this.db.prepare('SELECT 1 FROM api_model_configs WHERE id=?').get(modelId))
        throw new Error('MODEL_CONFIG_NOT_FOUND');
      this.db.prepare('UPDATE app_settings SET default_preset_id=?,default_api_model_config_id=?,updated_at=? WHERE id=1')
        .run(presetId, modelId, Date.now());
      return this.get();
    });
  }
}
