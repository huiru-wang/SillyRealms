import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { ModelRepository, type StoredModelConfig } from './repository.js';
import type { CreateModelInput, ModelConfig, ModelListOptions, ModelPage, UpdateModelInput } from './types.js';

export type ModelReader = Pick<ModelService, 'get' | 'require'>;

export type { CreateModelInput, ModelConfig, ModelListOptions, ModelPage, UpdateModelInput } from './types.js';

const valueSchema = z.object({
  name: z.string().trim().min(1),
  providerId: z.string().trim().min(1),
  modelId: z.string().trim().min(1),
  credentialRef: z.string().trim().min(1),
}).strict();
const createSchema = valueSchema.extend({ id: z.string().trim().min(1).optional() }).strict();
const patchSchema = valueSchema.partial().strict()
  .refine(value => Object.values(value).some(item => item !== undefined), '模型配置更新不能为空');
const listSchema = z.object({
  limit: z.number().int().min(1).max(1000).default(100),
  offset: z.number().int().min(0).default(0),
}).strict();

function toModelConfig(record: StoredModelConfig): ModelConfig {
  return {
    id: record.id,
    name: record.name,
    providerId: record.provider_id,
    modelId: record.model_id,
    credentialRef: record.credential_ref,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

/** Manages model connections; credential bytes never enter this module. */
export class ModelService {
  readonly #repository: ModelRepository;

  constructor(db: DatabaseSync) {
    this.#repository = new ModelRepository(db);
  }

  get(id: string): ModelConfig | null {
    const record = this.#repository.get(id);
    return record ? toModelConfig(record) : null;
  }

  require(id: string): ModelConfig {
    const value = this.get(id);
    if (!value) throw new AppError('MODEL_CONFIG_NOT_FOUND');
    return value;
  }

  list(options: ModelListOptions = {}): ModelConfig[] {
    return this.#repository.list(listSchema.parse(options)).map(toModelConfig);
  }

  listPage(options: ModelListOptions = {}): ModelPage {
    const page = listSchema.parse(options);
    const items = this.#repository.list({ ...page, limit: page.limit + 1 });
    return { items: items.slice(0, page.limit).map(toModelConfig), hasMore: items.length > page.limit };
  }

  create(input: CreateModelInput): ModelConfig {
    const { id = randomUUID(), ...value } = createSchema.parse(input);
    this.#repository.create(id, value);
    return this.require(id);
  }

  update(id: string, input: UpdateModelInput): ModelConfig | null {
    const patch = patchSchema.parse(input);
    const current = this.get(id);
    if (!current) return null;
    const value = valueSchema.parse({
      name: patch.name ?? current.name,
      providerId: patch.providerId ?? current.providerId,
      modelId: patch.modelId ?? current.modelId,
      credentialRef: patch.credentialRef ?? current.credentialRef,
    });
    this.#repository.update(id, value);
    return this.require(id);
  }

  delete(id: string): boolean {
    return this.#repository.delete(id);
  }
}
