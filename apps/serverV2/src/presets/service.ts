import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { PresetRepository, type StoredPreset } from './repository.js';
import { presetValueSchema } from './schema.js';
import type { CreatePresetInput, Preset, PresetListOptions, PresetPage, UpdatePresetInput } from './types.js';

export type { CreatePresetInput, Preset, PresetListOptions, PresetPage, UpdatePresetInput } from './types.js';
export type { NarrativePresetConfig, PresetNode } from './schema.js';

const createSchema = presetValueSchema.extend({ id: z.string().trim().min(1).optional() }).strict();
const patchSchema = presetValueSchema.extend({ description: z.string().nullable() }).partial().strict()
  .refine(value => Object.values(value).some(item => item !== undefined), '预设更新不能为空');
const listSchema = z.object({
  type: z.literal('narrative').default('narrative'),
  limit: z.number().int().min(1).max(1000).default(100),
  offset: z.number().int().min(0).default(0),
}).strict();

function toPreset(record: StoredPreset): Preset {
  const config = record.config_json;
  return {
    id: record.id,
    ...presetValueSchema.parse({
      type: record.type,
      name: record.name,
      description: record.description,
      config: {
        schemaVersion: config.schema_version,
        nodes: config.nodes,
        contextStrategy: {
          strategy: config.context_strategy.strategy,
          maxContextTokens: config.context_strategy.max_context_tokens,
          maxOutputTokens: config.context_strategy.max_output_tokens,
          summaryPrompt: config.context_strategy.summary_prompt,
        },
        modelParameters: {
          ...(config.model_parameters.temperature === undefined ? {} : { temperature: config.model_parameters.temperature }),
          thinkingEnabled: config.model_parameters.thinking_enabled,
        },
      },
    }),
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export class PresetService {
  readonly #repository: PresetRepository;

  constructor(db: DatabaseSync) {
    this.#repository = new PresetRepository(db);
  }

  get(id: string): Preset | null {
    const value = this.#repository.get(id);
    return value ? toPreset(value) : null;
  }

  require(id: string): Preset {
    const value = this.get(id);
    if (!value) throw new AppError('PRESET_NOT_FOUND');
    return value;
  }

  list(options: PresetListOptions = {}): Preset[] {
    return this.#repository.list(listSchema.parse(options)).map(toPreset);
  }

  listPage(options: PresetListOptions = {}): PresetPage {
    const page = listSchema.parse(options);
    const items = this.#repository.list({ ...page, limit: page.limit + 1 });
    return { items: items.slice(0, page.limit).map(toPreset), hasMore: items.length > page.limit };
  }

  create(input: CreatePresetInput): Preset {
    const { id = randomUUID(), ...value } = createSchema.parse(input);
    this.#repository.create(id, value);
    return this.require(id);
  }

  update(id: string, input: UpdatePresetInput): Preset | null {
    const patch = patchSchema.parse(input);
    const current = this.get(id);
    if (!current) return null;
    const value = presetValueSchema.parse({
      type: patch.type ?? current.type,
      name: patch.name ?? current.name,
      description: patch.description === undefined ? current.description : patch.description,
      config: patch.config ?? current.config,
    });
    this.#repository.update(id, value);
    return this.require(id);
  }

  delete(id: string): boolean {
    return this.#repository.delete(id);
  }
}
