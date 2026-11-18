import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { ModelReader } from '../models/service.js';
import type { PresetReader } from '../presets/service.js';
import { SettingsRepository, type StoredAppSettings } from './repository.js';
import type { AppSettings, SettingsDefaults, SettingsPatch } from './types.js';

export type { AppSettings, SettingsDefaults, SettingsPatch } from './types.js';

export type SettingsReader = Pick<SettingsService, 'get' | 'getOptional'>;

const valueSchema = z.object({
  defaultPresetId: z.string().trim().min(1).nullable(),
  defaultApiModelConfigId: z.string().trim().min(1).nullable(),
}).strict();
const patchSchema = valueSchema.partial().refine(value => Object.values(value).some(item => item !== undefined), '应用默认设置更新不能为空');

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
  readonly #services: { presets: PresetReader; models: ModelReader };

  constructor(db: DatabaseSync, services: { presets: PresetReader; models: ModelReader }) {
    this.#services = services;
    this.#repository = new SettingsRepository(db);
  }

  getOptional(): AppSettings | null {
    const record = this.#repository.getOptional();
    return record ? toAppSettings(record) : null;
  }

  ensure(defaults: SettingsDefaults): AppSettings {
    const current = this.getOptional();
    if (current) return current;
    const value = valueSchema.parse(defaults);
    if (value.defaultPresetId !== null) this.#services.presets.require(value.defaultPresetId);
    if (value.defaultApiModelConfigId !== null) this.#services.models.require(value.defaultApiModelConfigId);
    return toAppSettings(this.#repository.ensure(value));
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
