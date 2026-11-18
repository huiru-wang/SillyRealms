import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { ModelRepository } from './repository.js';
import type { CreateModelInput, ModelConfig, ModelListOptions, UpdateModelInput } from './types.js';

export type { CreateModelInput, ModelConfig, ModelListOptions, UpdateModelInput } from './types.js';

const valueSchema = z.object({
  name: z.string().trim().min(1),
  provider_id: z.string().trim().min(1),
  model_id: z.string().trim().min(1),
  credential_ref: z.string().trim().min(1),
}).strict();
const createSchema = valueSchema.extend({ id: z.string().trim().min(1).optional() }).strict();
const patchSchema = valueSchema.partial().strict()
  .refine(value => Object.values(value).some(item => item !== undefined), '模型配置更新不能为空');
const listSchema = z.object({
  limit: z.number().int().min(1).max(1000).default(100),
  offset: z.number().int().min(0).default(0),
}).strict();

/** Manages model connections; credential bytes never enter this module. */
export class ModelService {
  readonly #repository: ModelRepository;

  constructor(db: DatabaseSync) {
    this.#repository = new ModelRepository(db);
  }

  get(id: string): ModelConfig | null {
    return this.#repository.get(id);
  }

  require(id: string): ModelConfig {
    const value = this.get(id);
    if (!value) throw new AppError('MODEL_CONFIG_NOT_FOUND');
    return value;
  }

  list(options: ModelListOptions = {}): ModelConfig[] {
    return this.#repository.list(listSchema.parse(options));
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
      provider_id: patch.provider_id ?? current.provider_id,
      model_id: patch.model_id ?? current.model_id,
      credential_ref: patch.credential_ref ?? current.credential_ref,
    });
    this.#repository.update(id, value);
    return this.require(id);
  }

  delete(id: string): boolean {
    return this.#repository.delete(id);
  }
}
