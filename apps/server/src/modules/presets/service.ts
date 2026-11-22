import { decodeParameters } from './model-parameters.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { parsePresetDocument, toPresetDocument, type PresetDocument } from './card.js';
import { DEFAULT_PRESET_ID, defaultPreset } from './default.js';
import { PresetRepository, type StoredPreset } from './repository.js';
import { presetValueSchema } from './schema.js';
import type { CreatePresetInput, Preset, PresetListOptions, PresetPage, PresetSummary, UpdatePresetInput } from './types.js';

export type { CreatePresetInput, Preset, PresetListOptions, PresetPage, PresetSummary, UpdatePresetInput } from './types.js';
export { systemVariableNames } from './schema.js';
export type { NarrativePresetConfig, PresetNode } from './schema.js';
export type { PresetDocument } from './card.js';
export { resolvePostprocessPrompts } from './postprocess.js';
export type PresetReader = Pick<PresetService, 'get' | 'require' | 'list' | 'listPage' | 'getDefault' | 'toDocument'>;

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
    revision: record.revision,
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
        modelParameters: decodeParameters(config.model_parameters),
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

  getDefault(): CreatePresetInput {
    return presetValueSchema.parse(defaultPreset());
  }

  ensureDefault(): Preset {
    const value = presetValueSchema.parse(defaultPreset());
    for (let suffix = 0; ; suffix++) {
      const current = this.get(DEFAULT_PRESET_ID);
      if (current) return current;
      const name = suffix === 0 ? value.name : value.name + '(' + suffix + ')';
      if (this.#repository.createIfAvailable(DEFAULT_PRESET_ID, { ...value, name })) return this.require(DEFAULT_PRESET_ID);
    }
  }

  importDocument(input: unknown): Preset {
    const value = parsePresetDocument(input);
    for (let suffix = 0; ; suffix++) {
      const id = randomUUID(), name = suffix === 0 ? value.name : value.name + '(' + suffix + ')';
      if (this.#repository.createIfAvailable(id, { ...value, name })) return this.require(id);
    }
  }

  toDocument(input: CreatePresetInput): PresetDocument {
    const value = presetValueSchema.parse({
      type: input.type, name: input.name, description: input.description, config: input.config,
    });
    return toPresetDocument(value);
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
    const records = this.#repository.listSummaries({ ...page, limit: page.limit + 1 });
    const items: PresetSummary[] = records.slice(0, page.limit).map(record => ({
      id: record.id, type: z.literal('narrative').parse(record.type), name: record.name, description: record.description,
      revision: record.revision, createdAt: record.created_at, updatedAt: record.updated_at,
    }));
    return { items, hasMore: records.length > page.limit };
  }

  create(input: CreatePresetInput): Preset {
    const { id = randomUUID(), ...value } = createSchema.parse(input);
    this.#repository.create(id, value);
    return this.require(id);
  }

  update(id: string, input: UpdatePresetInput, expectedRevision?: number): Preset | null {
    const patch = patchSchema.parse(input);
    const current = this.get(id);
    if (!current) return null;
    const value = presetValueSchema.parse({
      type: patch.type ?? current.type,
      name: patch.name ?? current.name,
      description: patch.description === undefined ? current.description : patch.description,
      config: patch.config ?? current.config,
    });
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) throw new AppError('INVALID_REQUEST');
    if (!this.#repository.update(id, value, expectedRevision ?? current.revision)) throw new AppError('PRESET_REVISION_CONFLICT');
    return this.require(id);
  }

  delete(id: string): boolean {
    return this.#repository.delete(id);
  }
}
