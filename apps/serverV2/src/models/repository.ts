import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { transaction } from '../database/connection.js';

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

export type CreateModelInput = z.input<typeof createSchema>;
export type UpdateModelInput = z.input<typeof patchSchema>;
export type ModelConfig = z.infer<typeof valueSchema> & {
  id: string;
  created_at: number;
  updated_at: number;
};

function decode(row: Record<string, unknown>): ModelConfig {
  return {
    id: String(row.id),
    ...valueSchema.parse({
      name: row.name, provider_id: row.provider_id, model_id: row.model_id, credential_ref: row.credential_ref,
    }),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

/** Stores credential references only. Credential bytes belong to the credential store. */
export class ModelRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(id: string): ModelConfig | null {
    const row = this.db.prepare('SELECT * FROM api_model_configs WHERE id=?').get(id);
    return row ? decode(row) : null;
  }

  list(options: z.input<typeof listSchema> = {}): ModelConfig[] {
    const { limit, offset } = listSchema.parse(options);
    return this.db.prepare('SELECT * FROM api_model_configs ORDER BY name,id LIMIT ? OFFSET ?')
      .all(limit, offset).map(decode);
  }

  create(input: CreateModelInput): ModelConfig {
    const value = createSchema.parse(input);
    const id = value.id ?? randomUUID();
    return transaction(this.db, () => {
      const now = Date.now();
      this.db.prepare('INSERT INTO api_model_configs(id,name,provider_id,model_id,credential_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(id, value.name, value.provider_id, value.model_id, value.credential_ref, now, now);
      return this.get(id)!;
    });
  }

  update(id: string, input: UpdateModelInput): ModelConfig | null {
    const patch = patchSchema.parse(input);
    return transaction(this.db, () => {
      const current = this.get(id);
      if (!current) return null;
      const value = valueSchema.parse({
        name: patch.name ?? current.name,
        provider_id: patch.provider_id ?? current.provider_id,
        model_id: patch.model_id ?? current.model_id,
        credential_ref: patch.credential_ref ?? current.credential_ref,
      });
      this.db.prepare('UPDATE api_model_configs SET name=?,provider_id=?,model_id=?,credential_ref=?,updated_at=? WHERE id=?')
        .run(value.name, value.provider_id, value.model_id, value.credential_ref, Date.now(), id);
      return this.get(id)!;
    });
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM api_model_configs WHERE id=?').run(id).changes > 0;
  }
}
