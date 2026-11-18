import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { PresetRepository, type StoredPreset } from './repository.js';
import { presetValueSchema } from './schema.js';
import type { CreatePresetInput, Preset, PresetListOptions, UpdatePresetInput } from './types.js';

export type { CreatePresetInput, Preset, PresetListOptions, UpdatePresetInput } from './types.js';
export type { NarrativePresetConfig, PresetNode } from './schema.js';

const createSchema = presetValueSchema.extend({ id: z.string().trim().min(1).optional() }).strict();
const patchSchema = presetValueSchema.extend({ description: z.string().nullable() }).partial().strict()
  .refine(value => Object.values(value).some(item => item !== undefined), '预设更新不能为空');
const listSchema = z.object({
  type: z.literal('narrative').default('narrative'),
  limit: z.number().int().min(1).max(1000).default(100),
  offset: z.number().int().min(0).default(0),
}).strict();

function preset(row: StoredPreset): Preset {
  return {
    id: row.id,
    ...presetValueSchema.parse({
      type: row.type, name: row.name, description: row.description, config_json: row.config_json,
    }),
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

export class PresetService {
  readonly #repository: PresetRepository;

  constructor(db: DatabaseSync) {
    this.#repository = new PresetRepository(db);
  }

  get(id: string): Preset | null {
    const row = this.#repository.get(id);
    return row ? preset(row) : null;
  }

  require(id: string): Preset {
    const value = this.get(id);
    if (!value) throw new AppError('PRESET_NOT_FOUND');
    return value;
  }

  list(options: PresetListOptions = {}): Preset[] {
    return this.#repository.list(listSchema.parse(options)).map(preset);
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
      config_json: patch.config_json ?? current.config_json,
    });
    this.#repository.update(id, value);
    return this.require(id);
  }

  delete(id: string): boolean {
    return this.#repository.delete(id);
  }
}
