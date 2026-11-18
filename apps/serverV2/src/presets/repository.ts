import type { DatabaseSync } from 'node:sqlite';
import { encodeJson, type JsonValue } from '../database/connection.js';
import type { PresetValue } from './types.js';

export type StoredPreset = {
  id: string;
  type: string;
  name: string;
  description: string | null;
  config_json: JsonValue;
  created_at: number;
  updated_at: number;
};

function decode(row: Record<string, unknown>): StoredPreset {
  return {
    id: String(row.id), type: String(row.type), name: String(row.name),
    description: row.description === null ? null : String(row.description),
    config_json: JSON.parse(String(row.config_json)) as JsonValue,
    created_at: Number(row.created_at), updated_at: Number(row.updated_at),
  };
}

/** Module-private persistence for the presets table. */
export class PresetRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(id: string): StoredPreset | null {
    const row = this.db.prepare('SELECT * FROM presets WHERE id=?').get(id);
    return row ? decode(row) : null;
  }

  list({ type, limit, offset }: { type: string; limit: number; offset: number }): StoredPreset[] {
    return this.db.prepare('SELECT * FROM presets WHERE type=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?')
      .all(type, limit, offset).map(decode);
  }

  create(id: string, value: PresetValue): void {
    const now = Date.now();
    this.db.prepare('INSERT INTO presets(id,type,name,description,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, value.type, value.name, value.description, encodeJson(value.config_json, 'object'), now, now);
  }

  update(id: string, value: PresetValue): void {
    this.db.prepare('UPDATE presets SET type=?,name=?,description=?,config_json=?,updated_at=? WHERE id=?')
      .run(value.type, value.name, value.description, encodeJson(value.config_json, 'object'), Date.now(), id);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM presets WHERE id=?').run(id).changes > 0;
  }
}
