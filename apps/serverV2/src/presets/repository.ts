import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { encodeJson, transaction } from '../database/connection.js';
import { presetValueSchema } from './schema.js';

const idSchema = z.string().trim().min(1);
const createSchema = presetValueSchema.extend({ id: idSchema.optional() }).strict();
const patchSchema = presetValueSchema.extend({ description: z.string().nullable() }).partial().strict()
  .refine(value => Object.values(value).some(item => item !== undefined), '预设更新不能为空');
const listSchema = z.object({
  type: z.literal('narrative').default('narrative'),
  limit: z.number().int().min(1).max(1000).default(100),
  offset: z.number().int().min(0).default(0),
}).strict();

export type CreatePresetInput = z.input<typeof createSchema>;
export type UpdatePresetInput = z.input<typeof patchSchema>;
export type Preset = z.infer<typeof presetValueSchema> & {
  id: string;
  created_at: number;
  updated_at: number;
};

function decode(row: Record<string, unknown>): Preset {
  return {
    id: String(row.id),
    ...presetValueSchema.parse({
      type: row.type, name: row.name, description: row.description,
      config_json: JSON.parse(String(row.config_json)),
    }),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

/** Defaults in worlds, sessions and app settings currently select narrative presets. */
export function assertNarrativePreset(db: DatabaseSync, id: string): void {
  const row = db.prepare('SELECT type FROM presets WHERE id=?').get(id);
  if (!row) throw new Error('PRESET_NOT_FOUND');
  if (row.type !== 'narrative') throw new Error('NARRATIVE_PRESET_REQUIRED');
}

export class PresetRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(id: string): Preset | null {
    const row = this.db.prepare('SELECT * FROM presets WHERE id=?').get(id);
    return row ? decode(row) : null;
  }

  list(options: z.input<typeof listSchema> = {}): Preset[] {
    const { type, limit, offset } = listSchema.parse(options);
    return this.db.prepare('SELECT * FROM presets WHERE type=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?')
      .all(type, limit, offset).map(decode);
  }

  create(input: CreatePresetInput): Preset {
    const value = createSchema.parse(input);
    const id = value.id ?? randomUUID();
    const config = encodeJson(value.config_json, 'object');
    return transaction(this.db, () => {
      const now = Date.now();
      this.db.prepare('INSERT INTO presets(id,type,name,description,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(id, value.type, value.name, value.description, config, now, now);
      return this.get(id)!;
    });
  }

  update(id: string, input: UpdatePresetInput): Preset | null {
    const patch = patchSchema.parse(input);
    return transaction(this.db, () => {
      const current = this.get(id);
      if (!current) return null;
      const value = presetValueSchema.parse({
        type: patch.type ?? current.type,
        name: patch.name ?? current.name,
        description: patch.description === undefined ? current.description : patch.description,
        config_json: patch.config_json ?? current.config_json,
      });
      this.db.prepare('UPDATE presets SET type=?,name=?,description=?,config_json=?,updated_at=? WHERE id=?')
        .run(value.type, value.name, value.description, encodeJson(value.config_json, 'object'), Date.now(), id);
      return this.get(id)!;
    });
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM presets WHERE id=?').run(id).changes > 0;
  }
}
