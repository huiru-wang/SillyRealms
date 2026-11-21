import { transaction } from '../../infrastructure/database/transaction.js';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { encodeJson, type JsonObject, type JsonValue } from '../../infrastructure/database/connection.js';
import type { WorldDescription, WorldListOptions } from './types.js';

/** Decoded storage rows stay inside this module; only the Service exposes domain objects. */
export type WorldContentRow = {
  spec_version: string;
  name: string;
  description: WorldDescription;
  cover: string | null;
  characters_json: JsonValue[];
  openings_json: JsonValue[];
  lorebook_json: JsonValue | null;
  state_definition_json: JsonValue | null;
  message_render_json: JsonValue | null;
  components: JsonValue[] | null;
  stage_component: string | null;
  extensions_json: JsonValue | null;
  default_preset_id: string | null;
  default_api_model_config_id: string | null;
};
export type WorldRow = WorldContentRow & {
  id: string; revision: number; state: JsonObject; tags: string[]; created_at: number; updated_at: number;
};
const contentColumns = [
  'spec_version', 'name', 'description', 'cover', 'characters_json', 'openings_json',
  'lorebook_json', 'state_definition_json', 'message_render_json', 'components',
  'stage_component', 'extensions_json', 'default_preset_id', 'default_api_model_config_id',
] as const;
const nullableJsonFields = new Set(['description', 'lorebook_json', 'state_definition_json', 'message_render_json', 'extensions_json']);

function contentValues(input: WorldContentRow): SQLInputValue[] {
  return contentColumns.map(field => {
    const value = input[field];
    if (field === 'characters_json' || field === 'openings_json') return encodeJson(value, 'array');
    if (field === 'components') return value === null ? null : encodeJson(value, 'array');
    if (nullableJsonFields.has(field)) return value === null ? null : encodeJson(value);
    return value as SQLInputValue;
  });
}

function readDescription(value: unknown): WorldDescription {
  if (value === null) return null;
  const text = String(value);
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
      'type' in parsed && parsed.type === 'component' && 'component' in parsed && typeof parsed.component === 'string') {
      return { type: 'component', component: parsed.component };
    }
  } catch { /* Earlier V2 rows stored descriptions as unencoded text. */ }
  return text;
}

/** Module-private persistence; each transaction contains only worlds and world_tags SQL. */
export class WorldRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(id: string): WorldRow | null {
    const row = this.db.prepare('SELECT * FROM worlds WHERE id = ?').get(id);
    if (!row) return null;
    const nullableJson = (key: string): JsonValue | null =>
      row[key] === null ? null : JSON.parse(String(row[key])) as JsonValue;
    return {
      id: String(row.id), revision: Number(row.revision),
      spec_version: String(row.spec_version),
      name: String(row.name),
      description: readDescription(row.description),
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

  listUsingDefaultPreset(presetId: string) {
    return this.db.prepare('SELECT id, name FROM worlds WHERE default_preset_id = ? ORDER BY name, id')
      .all(presetId).map(row => ({ id: String(row.id), name: String(row.name) }));
  }

  list(options: WorldListOptions): WorldRow[] {
    return this.listSummaries(options).map(row => this.get(row.id)!);
  }

  listSummaries({ q, tag, before, limit = 50, offset = 0 }: WorldListOptions) {
    const conditions: string[] = [], args: SQLInputValue[] = [];
    if (q) { conditions.push('instr(w.name, ?) > 0'); args.push(q); }
    if (tag) { conditions.push('EXISTS (SELECT 1 FROM world_tags t WHERE t.world_id=w.id AND t.name=?)'); args.push(tag); }
    if (before) { conditions.push('(w.created_at < ? OR (w.created_at = ? AND w.id < ?))'); args.push(before.createdAt, before.createdAt, before.id); }
    const filter = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const rows = this.db.prepare('SELECT w.id,w.name,w.cover,w.created_at,w.updated_at FROM worlds w' + filter + ' ORDER BY w.created_at DESC,w.id DESC LIMIT ? OFFSET ?').all(...args, limit, offset);
    const tags = new Map<string, string[]>();
    if (rows.length) {
      for (const row of this.db.prepare('SELECT world_id,name FROM world_tags WHERE world_id IN (' + rows.map(() => '?').join(',') + ') ORDER BY world_id,sort_order,name').all(...rows.map(row => String(row.id)))) {
        const id = String(row.world_id); const values = tags.get(id) ?? []; values.push(String(row.name)); tags.set(id, values);
      }
    }
    return rows.map(row => ({ id: String(row.id), name: String(row.name), cover: row.cover === null ? null : String(row.cover), tags: tags.get(String(row.id)) ?? [], created_at: Number(row.created_at), updated_at: Number(row.updated_at) }));
  }

  updateManagement(id: string, patch: { name?: string; default_preset_id?: string | null; default_api_model_config_id?: string | null }, tags: string[] | undefined, revision: number): WorldRow | null {
    return transaction(this.db, () => {
      const changes = Object.entries(patch);
      const assignments = changes.map(([key]) => key + '=?');
      assignments.push('revision=revision+1', 'updated_at=?');
      const result = this.db.prepare('UPDATE worlds SET ' + assignments.join(',') + ' WHERE id=? AND revision=?')
        .run(...changes.map(([,value]) => value!), Date.now(), id, revision);
      if (!result.changes) return null;
      if (tags !== undefined) this.writeTags(id, tags);
      return this.get(id)!;
    });
  }

  create(id: string, content: WorldContentRow, tags: readonly string[], value: JsonObject): WorldRow {
    const values = contentValues(content);
    const state = encodeJson(value, 'object');
    return transaction(this.db, () => {
      const now = Date.now();
      const fields = ['id', ...contentColumns, 'state', 'created_at', 'updated_at'];
      this.db.prepare('INSERT INTO worlds (' + fields.join(', ') + ') VALUES (' + fields.map(() => '?').join(', ') + ')')
        .run(id, ...values, state, now, now);
      this.writeTags(id, tags);
      return this.get(id)!;
    });
  }

  update(id: string, content: WorldContentRow, tags?: readonly string[]): WorldRow {
    const values = contentValues(content);
    return transaction(this.db, () => {
      this.db.prepare('UPDATE worlds SET ' + contentColumns.map(field => field + ' = ?').join(', ') + ', revision=revision+1, updated_at = ? WHERE id = ?')
        .run(...values, Date.now(), id);
      if (tags !== undefined) this.writeTags(id, tags);
      return this.get(id)!;
    });
  }

  listTags(): { name: string; world_count: number }[] {
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
