import type { DatabaseSync } from 'node:sqlite';
import { encodeJson } from '../../infrastructure/database/connection.js';
import type { PresetValue } from './types.js';

type StoredConfig = {
  schema_version: 1;
  nodes: PresetValue['config']['nodes'];
  context_strategy: {
    strategy: PresetValue['config']['contextStrategy']['strategy'];
    max_context_tokens: number;
    max_output_tokens: number;
    summary_prompt: string;
  };
  model_parameters: { temperature?: number; thinking_enabled: boolean };
};

export type StoredPreset = {
  id: string;
  revision: number;
  type: string;
  name: string;
  description: string | null;
  config_json: StoredConfig;
  created_at: number;
  updated_at: number;
};

export type StoredPresetSummary = Omit<StoredPreset, 'config_json'>;

function storedConfig(config: PresetValue['config']): StoredConfig {
  return {
    schema_version: config.schemaVersion,
    nodes: config.nodes,
    context_strategy: {
      strategy: config.contextStrategy.strategy,
      max_context_tokens: config.contextStrategy.maxContextTokens,
      max_output_tokens: config.contextStrategy.maxOutputTokens,
      summary_prompt: config.contextStrategy.summaryPrompt,
    },
    model_parameters: {
      ...(config.modelParameters.temperature === undefined ? {} : { temperature: config.modelParameters.temperature }),
      thinking_enabled: config.modelParameters.thinkingEnabled,
    },
  };
}

function decode(row: Record<string, unknown>): StoredPreset {
  return {
    id: String(row.id), revision: Number(row.revision), type: String(row.type), name: String(row.name),
    description: row.description === null ? null : String(row.description),
    config_json: JSON.parse(String(row.config_json)) as StoredConfig,
    created_at: Number(row.created_at), updated_at: Number(row.updated_at),
  };
}

/** Module-private persistence; database names and stored config stay inside this module. */
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

  listSummaries({ type, limit, offset }: { type: string; limit: number; offset: number }): StoredPresetSummary[] {
    return this.db.prepare('SELECT id,type,name,description,revision,created_at,updated_at FROM presets WHERE type=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?')
      .all(type, limit, offset).map(row => ({
        id: String(row.id), type: String(row.type), name: String(row.name), description: row.description === null ? null : String(row.description),
        revision: Number(row.revision), created_at: Number(row.created_at), updated_at: Number(row.updated_at),
      }));
  }

  create(id: string, value: PresetValue): void {
    const now = Date.now();
    this.db.prepare('INSERT INTO presets(id,type,name,description,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, value.type, value.name, value.description, encodeJson(storedConfig(value.config), 'object'), now, now);
  }

  createIfAvailable(id: string, value: PresetValue): boolean {
    const now = Date.now();
    return this.db.prepare('INSERT INTO presets(id,type,name,description,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .run(id, value.type, value.name, value.description, encodeJson(storedConfig(value.config), 'object'), now, now).changes > 0;
  }

  update(id: string, value: PresetValue, expectedRevision: number): boolean {
    return this.db.prepare('UPDATE presets SET type=?,name=?,description=?,config_json=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=?')
      .run(value.type, value.name, value.description, encodeJson(storedConfig(value.config), 'object'), Date.now(), id, expectedRevision).changes > 0;
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM presets WHERE id=?').run(id).changes > 0;
  }
}
