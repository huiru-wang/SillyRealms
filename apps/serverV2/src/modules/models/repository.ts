import type { DatabaseSync } from 'node:sqlite';
import type { ModelValue } from './types.js';

export type StoredModelConfig = {
  id: string;
  name: string;
  provider_id: string;
  model_id: string;
  credential_ref: string;
  created_at: number;
  updated_at: number;
};

function decode(row: Record<string, unknown>): StoredModelConfig {
  return {
    id: String(row.id), name: String(row.name), provider_id: String(row.provider_id),
    model_id: String(row.model_id), credential_ref: String(row.credential_ref),
    created_at: Number(row.created_at), updated_at: Number(row.updated_at),
  };
}

/** Module-private persistence for model connection references. */
export class ModelRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(id: string): StoredModelConfig | null {
    const row = this.db.prepare('SELECT * FROM api_model_configs WHERE id=?').get(id);
    return row ? decode(row) : null;
  }

  list({ limit, offset }: { limit: number; offset: number }): StoredModelConfig[] {
    return this.db.prepare('SELECT * FROM api_model_configs ORDER BY name,id LIMIT ? OFFSET ?')
      .all(limit, offset).map(decode);
  }

  create(id: string, value: ModelValue): void {
    const now = Date.now();
    this.db.prepare('INSERT INTO api_model_configs(id,name,provider_id,model_id,credential_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, value.name, value.providerId, value.modelId, value.credentialRef, now, now);
  }

  update(id: string, value: ModelValue): void {
    this.db.prepare('UPDATE api_model_configs SET name=?,provider_id=?,model_id=?,credential_ref=?,updated_at=? WHERE id=?')
      .run(value.name, value.providerId, value.modelId, value.credentialRef, Date.now(), id);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM api_model_configs WHERE id=?').run(id).changes > 0;
  }
}
