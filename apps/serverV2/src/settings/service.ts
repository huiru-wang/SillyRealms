import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { ModelService } from '../models/service.js';
import type { PresetService } from '../presets/service.js';
import { SettingsRepository, type StoredAppSettings } from './repository.js';
import type { AppSettings, SettingsPatch } from './types.js';

export type { AppSettings, SettingsPatch } from './types.js';

const patchSchema = z.object({
  defaultPresetId: z.string().trim().min(1).nullable().optional(),
  defaultApiModelConfigId: z.string().trim().min(1).nullable().optional(),
}).strict().refine(value => Object.values(value).some(item => item !== undefined), '应用默认设置更新不能为空');

function toAppSettings(record: StoredAppSettings): AppSettings {
  return {
    id: record.id,
    defaultPresetId: record.default_preset_id,
    defaultApiModelConfigId: record.default_api_model_config_id,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export class SettingsService {
  readonly #repository: SettingsRepository;
  readonly #services: { presets: PresetService; models: ModelService };

  constructor(db: DatabaseSync, services: { presets: PresetService; models: ModelService }) {
    this.#services = services;
    this.#repository = new SettingsRepository(db);
  }

  get(): AppSettings {
    return toAppSettings(this.#repository.get());
  }

  update(input: SettingsPatch): AppSettings {
    const patch = patchSchema.parse(input);
    const current = this.get();
    const presetId = patch.defaultPresetId === undefined ? current.defaultPresetId : patch.defaultPresetId;
    const modelId = patch.defaultApiModelConfigId === undefined ? current.defaultApiModelConfigId : patch.defaultApiModelConfigId;
    if (presetId !== null) this.#services.presets.require(presetId);
    if (modelId !== null) this.#services.models.require(modelId);
    return toAppSettings(this.#repository.update({ defaultPresetId: presetId, defaultApiModelConfigId: modelId }));
  }
}
