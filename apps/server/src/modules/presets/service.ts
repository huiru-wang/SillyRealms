import { decodeParameters } from './model-parameters.js';
import type { ModelReader } from '../models/service.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { parsePresetDocument, toPresetDocument, type PresetDocument } from './card.js';
import { builtinPresets } from './default.js';
import { loadInitialData, resourceError } from '../../infrastructure/initial-data/catalog.js';
import { PresetRepository, type StoredPreset } from './repository.js';
import { presetValueSchema } from './schema.js';
import type { CreatePresetInput, Preset, PresetListOptions, PresetPage, PresetSummary, UpdatePresetInput } from './types.js';

export type { CreatePresetInput, Preset, PresetListOptions, PresetPage, PresetSummary, UpdatePresetInput } from './types.js';
export { replyVariableNames, parsePresetNodePrompt, postprocessNodeIds, systemVariableNames } from './schema.js';
export type { NarrativePresetConfig, PresetNode } from './schema.js';
export type { PresetDocument } from './card.js';
export { characterSpriteAvailable, resolvePostprocessPrompts } from './postprocess.js';
export type { PostprocessNodeId, PostprocessPrompts } from './postprocess.js';
export type PresetReader = Pick<PresetService, 'get' | 'require' | 'list' | 'listPage' | 'getDefault' | 'toDocument'>;

const presetType = z.enum(['narrative', 'reply_assist']);
const patchSchema = z.object({
  type: presetType.optional(), name: z.string().optional(), description: z.string().nullable().optional(),
  config: z.unknown().optional(), apiModelConfigId: z.string().nullable().optional(),
}).strict().refine(value => Object.values(value).some(item => item !== undefined), '预设更新不能为空');
const listSchema = z.object({
  type: presetType.default('narrative'),
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
      ...(record.type === 'reply_assist' ? { apiModelConfigId: record.api_model_config_id } : {}),
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

  readonly #templates: ReturnType<typeof builtinPresets>;
  readonly #defaultId: string;

  readonly defaultReplyAssistId: string | null;
  constructor(db: DatabaseSync, private readonly models: ModelReader, catalog = loadInitialData()) {
    this.#templates = builtinPresets(catalog);
    this.#defaultId = catalog.defaultPresetId;
    this.defaultReplyAssistId = catalog.defaultReplyAssistPresetId ?? null;
    this.#repository = new PresetRepository(db);
  }

  getDefault(): Extract<CreatePresetInput, { type: 'narrative' }>;
  getDefault(type: Preset['type']): CreatePresetInput;
  getDefault(type: Preset['type'] = 'narrative'): CreatePresetInput {
    const id = type === 'narrative' ? this.#defaultId : this.defaultReplyAssistId;
    const template = id && this.#templates.get(id);
    if (!template) throw new AppError('PRESET_NOT_FOUND');
    if (template.value.type !== type) throw new AppError('PRESET_TYPE_MISMATCH');
    return structuredClone(template.value);
  }

  ensureDefault(): Preset {
    return this.ensureBuiltin(this.#defaultId);
  }

  ensureBuiltins(): string {
    for (const [id, { file }] of this.#templates) {
      try {
        this.ensureBuiltin(id);
      } catch (error) {
        throw resourceError('presets/' + file + ' (' + id + ')', error);
      }
    }
    return this.#defaultId;
  }

  private ensureBuiltin(id: string): Preset {
    const { value } = this.#templates.get(id)!;
    for (let suffix = 0; ; suffix++) {
      const current = this.get(id);
      if (current) return current;
      const name = suffix === 0 ? value.name : value.name + '(' + suffix + ')';
      if (this.#repository.createIfAvailable(id, { ...value, name })) return this.require(id);
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

  require(id: string, expectedType?: Preset['type']): Preset {
    const value = this.get(id);
    if (!value) throw new AppError('PRESET_NOT_FOUND');
    if (expectedType && value.type !== expectedType) throw new AppError('PRESET_TYPE_MISMATCH');
    return value;
  }

  list(options: PresetListOptions = {}): Preset[] {
    return this.#repository.list(listSchema.parse(options)).map(toPreset);
  }

  listPage(options: PresetListOptions = {}): PresetPage {
    const page = listSchema.parse(options);
    const records = this.#repository.listSummaries({ ...page, limit: page.limit + 1 });
    const items: PresetSummary[] = records.slice(0, page.limit).map(record => ({
      id: record.id, type: presetType.parse(record.type), name: record.name, description: record.description,
      revision: record.revision, createdAt: record.created_at, updatedAt: record.updated_at,
    }));
    return { items, hasMore: records.length > page.limit };
  }

  create(input: CreatePresetInput): Preset {
    const { id: provided, ...fields } = input;
    const id = provided === undefined ? randomUUID() : z.string().trim().min(1).parse(provided);
    const value = presetValueSchema.parse(fields);
    if (value.type === 'reply_assist' && value.apiModelConfigId) this.models.require(value.apiModelConfigId);
    this.#repository.create(id, value);
    return this.require(id);
  }

  update(id: string, input: UpdatePresetInput, expectedRevision?: number): Preset | null {
    const patch = patchSchema.parse(input);
    const current = this.get(id);
    if (!current) return null;
    if (patch.type && patch.type !== current.type) throw new AppError('PRESET_TYPE_MISMATCH');
    const value = presetValueSchema.parse({
      type: current.type,
      ...(current.type === 'reply_assist' ? { apiModelConfigId: current.apiModelConfigId } : {}),
      ...(patch.apiModelConfigId === undefined ? {} : { apiModelConfigId: patch.apiModelConfigId }),
      name: patch.name ?? current.name,
      description: patch.description === undefined ? current.description : patch.description,
      config: patch.config === undefined ? current.config : patch.config,
    });
    if (value.type === 'reply_assist' && value.apiModelConfigId) this.models.require(value.apiModelConfigId);
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) throw new AppError('INVALID_REQUEST');
    if (!this.#repository.update(id, value, expectedRevision ?? current.revision)) throw new AppError('PRESET_REVISION_CONFLICT');
    return this.require(id);
  }

  delete(id: string): boolean {
    return this.#repository.delete(id);
  }
}
