import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { ModelService } from '../models/service.js';
import type { PresetService } from '../presets/service.js';
import { SettingsRepository } from './repository.js';
import type { AppSettings, SettingsPatch } from './types.js';

export type { AppSettings, SettingsPatch } from './types.js';

const patchSchema = z.object({
  default_preset_id: z.string().trim().min(1).nullable().optional(),
  default_api_model_config_id: z.string().trim().min(1).nullable().optional(),
}).strict().refine(value => Object.values(value).some(item => item !== undefined), '应用默认设置更新不能为空');

export class SettingsService {
  readonly #repository: SettingsRepository;
  readonly #services: { presets: PresetService; models: ModelService };

  constructor(db: DatabaseSync, services: { presets: PresetService; models: ModelService }) {
    this.#services = services;
    this.#repository = new SettingsRepository(db);
  }

  get(): AppSettings {
    return this.#repository.get();
  }

  update(input: SettingsPatch): AppSettings {
    const patch = patchSchema.parse(input);
    const current = this.#repository.get();
    const presetId = patch.default_preset_id === undefined ? current.default_preset_id : patch.default_preset_id;
    const modelId = patch.default_api_model_config_id === undefined ? current.default_api_model_config_id : patch.default_api_model_config_id;
    if (presetId !== null) this.#services.presets.require(presetId);
    if (modelId !== null) this.#services.models.require(modelId);
    return this.#repository.update({ default_preset_id: presetId, default_api_model_config_id: modelId });
  }
}
