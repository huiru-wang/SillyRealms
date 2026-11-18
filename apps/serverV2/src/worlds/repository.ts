import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { encodeJson, transaction, type JsonObject, type JsonValue } from '../database/connection.js';
import {
  worldContentFields, type WorldContent, type WorldListOptions, type WorldRecord, type WorldTag,
} from './types.js';

const nullableJsonFields = new Set(['lorebook_json', 'state_definition_json', 'message_render_json', 'extensions_json']);

function contentValues(input: WorldContent): SQLInputValue[] {
  return worldContentFields.map(field => {
    const value = input[field];
    if (field === 'characters_json' || field === 'openings_json') return encodeJson(value, 'array');
    if (field === 'components') return value === null ? null : encodeJson(value, 'array');
    if (nullableJsonFields.has(field)) return value === null ? null : encodeJson(value);
    return value as SQLInputValue;
  });
}

/** Module-private persistence; each transaction contains only worlds and world_tags SQL. */
export class WorldRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(id: string): WorldRecord | null {
    const row = this.db.prepare('SELECT * FROM worlds WHERE id = ?').get(id);
    if (!row) return null;
    const nullableJson = (key: string): JsonValue | null =>
      row[key] === null ? null : JSON.parse(String(row[key])) as JsonValue;
    return {
      id: String(row.id),
      spec_version: String(row.spec_version),
      name: String(row.name),
      description: row.description === null ? null : String(row.description),
      cover: row.cover === null ? null : String(row.cover),
      characters_json: JSON.parse(String(row.characters_json)) as JsonValue[],
      openings_json: JSON.parse(String(row.openings_json)) as JsonValue[],
      lorebook_json: nullableJson('lorebook_json'),
      state_definition_json: nullableJson('state_definition_json'),
      message_render_json: nullableJson('message_render_json'),
      components: nullableJson('components') as JsonValue[] | null,
      stage_component: row.stage_component === null ? null : String(row.stage_component),
      extensions_json: nullableJson('extensions_json'),
      default_preset_id: row.default_preset_id === null ? null : String(row.default_preset_id),
      default_api_model_config_id: row.default_api_model_config_id === null ? null : String(row.default_api_model_config_id),
      state: JSON.parse(String(row.state)) as JsonObject,
      tags: this.db.prepare('SELECT name FROM world_tags WHERE world_id = ? ORDER BY sort_order, name').all(id)
        .map(tag => String(tag.name)),
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    };
  }

  list({ tag, limit = 50, offset = 0 }: WorldListOptions): WorldRecord[] {
    const args: SQLInputValue[] = [];
    let filter = '';
    if (tag !== undefined) {
      filter = 'WHERE EXISTS (SELECT 1 FROM world_tags t WHERE t.world_id = w.id AND t.name = ?)';
      args.push(tag);
    }
    args.push(limit, offset);
    const rows = this.db.prepare('SELECT w.id FROM worlds w ' + filter + ' ORDER BY w.updated_at DESC, w.id DESC LIMIT ? OFFSET ?').all(...args);
    return rows.map(row => this.get(String(row.id))!);
  }

  create(id: string, content: WorldContent, tags: readonly string[], value: JsonObject): WorldRecord {
    const values = contentValues(content);
    const state = encodeJson(value, 'object');
    return transaction(this.db, () => {
      const now = Date.now();
      const columns = ['id', ...worldContentFields, 'state', 'created_at', 'updated_at'];
      this.db.prepare('INSERT INTO worlds (' + columns.join(', ') + ') VALUES (' + columns.map(() => '?').join(', ') + ')')
        .run(id, ...values, state, now, now);
      this.writeTags(id, tags);
      return this.get(id)!;
    });
  }

  update(id: string, content: WorldContent, tags?: readonly string[]): WorldRecord {
    const values = contentValues(content);
    return transaction(this.db, () => {
      this.db.prepare('UPDATE worlds SET ' + worldContentFields.map(field => field + ' = ?').join(', ') + ', updated_at = ? WHERE id = ?')
        .run(...values, Date.now(), id);
      if (tags !== undefined) this.writeTags(id, tags);
      return this.get(id)!;
    });
  }

  listTags(): WorldTag[] {
    return this.db.prepare('SELECT name, count(*) AS world_count FROM world_tags GROUP BY name ORDER BY name').all()
      .map(row => ({ name: String(row.name), world_count: Number(row.world_count) }));
  }

  delete(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM worlds WHERE id = ?').run(id).changes) > 0;
  }

  getState(worldId: string): JsonObject | null {
    const row = this.db.prepare('SELECT state FROM worlds WHERE id=?').get(worldId);
    return row ? JSON.parse(String(row.state)) as JsonObject : null;
  }

  setState(worldId: string, value: JsonObject): JsonObject | null {
    const state = encodeJson(value, 'object');
    const result = this.db.prepare('UPDATE worlds SET state=?,updated_at=? WHERE id=?')
      .run(state, Date.now(), worldId);
    return result.changes ? JSON.parse(state) as JsonObject : null;
  }

  private writeTags(id: string, tags: readonly string[]): void {
    this.db.prepare('DELETE FROM world_tags WHERE world_id = ?').run(id);
    const insert = this.db.prepare('INSERT INTO world_tags (world_id, name, sort_order) VALUES (?, ?, ?)');
    tags.forEach((name, index) => insert.run(id, name, index));
  }
}
