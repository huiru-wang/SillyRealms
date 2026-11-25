import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@sillyrealms/sdk/locale';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { ModelReader } from '../models/service.js';
import type { PresetReader } from '../presets/service.js';
import { SettingsRepository, type StoredAppSettings } from './repository.js';
import type { AppSettings, SettingsDefaults, SettingsPatch } from './types.js';

export type { AppSettings, SettingsDefaults, SettingsPatch } from './types.js';

export type SettingsReader = Pick<SettingsService, 'get' | 'getOptional'>;

const valueSchema = z.object({
  locale: z.enum(SUPPORTED_LOCALES),
  defaultReplyAssistPresetId: z.string().trim().min(1).nullable(),
  defaultPresetId: z.string().trim().min(1).nullable(),
  defaultApiModelConfigId: z.string().trim().min(1).nullable(),
}).strict();
const defaultsSchema = valueSchema.extend({ defaultReplyAssistPresetId: valueSchema.shape.defaultReplyAssistPresetId.default(null), locale: valueSchema.shape.locale.default(DEFAULT_LOCALE) });
const patchSchema = valueSchema.partial().refine(value => Object.values(value).some(item => item !== undefined), '应用默认设置更新不能为空');

function toAppSettings(record: StoredAppSettings): AppSettings {
  return {
    id: record.id,
    locale: record.locale,
    defaultReplyAssistPresetId: record.default_reply_assist_preset_id,
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
    const value = defaultsSchema.parse(defaults);
    if (value.defaultPresetId !== null) this.#services.presets.require(value.defaultPresetId, 'narrative');
    if (value.defaultReplyAssistPresetId) this.#services.presets.require(value.defaultReplyAssistPresetId, 'reply_assist');
    if (value.defaultApiModelConfigId !== null) this.#services.models.require(value.defaultApiModelConfigId);
    return toAppSettings(this.#repository.ensure(value));
  }

  get(): AppSettings {
    return toAppSettings(this.#repository.get());
  }

  update(input: SettingsPatch): AppSettings {
    const patch = patchSchema.parse(input);
    const current = this.get();
    const locale = patch.locale ?? current.locale;
    const presetId = patch.defaultPresetId === undefined ? current.defaultPresetId : patch.defaultPresetId;
    const modelId = patch.defaultApiModelConfigId === undefined ? current.defaultApiModelConfigId : patch.defaultApiModelConfigId;
    if (presetId !== null) this.#services.presets.require(presetId, 'narrative');
    const replyId = patch.defaultReplyAssistPresetId === undefined ? current.defaultReplyAssistPresetId : patch.defaultReplyAssistPresetId;
    if (replyId) this.#services.presets.require(replyId, 'reply_assist');
    if (modelId !== null) this.#services.models.require(modelId);
    return toAppSettings(this.#repository.update({ locale, defaultReplyAssistPresetId: replyId, defaultPresetId: presetId, defaultApiModelConfigId: modelId }));
  }
}
