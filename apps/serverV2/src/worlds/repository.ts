import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { encodeJson, transaction, type JsonObject, type JsonValue } from '../database/connection.js';
import { assertNarrativePreset } from '../presets/repository.js';
import { assertWorldId } from './files.js';

export type WorldContent = {
  spec_version: string;
  name: string;
  description: string | null;
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

export type CreateWorld = Pick<WorldContent, 'spec_version' | 'name' | 'characters_json' | 'openings_json'>
  & Partial<Omit<WorldContent, 'spec_version' | 'name' | 'characters_json' | 'openings_json'>>
  & { id?: string; state?: JsonObject; tags?: readonly string[] };
export type WorldPatch = Partial<WorldContent> & { tags?: readonly string[] };
export type WorldRecord = WorldContent & {
  id: string;
  state: JsonObject;
  tags: string[];
  created_at: number;
  updated_at: number;
};
export type WorldTag = { name: string; world_count: number };
export type WorldListOptions = { tag?: string; limit?: number; offset?: number };

const contentFields = [
  'spec_version', 'name', 'description', 'cover', 'characters_json', 'openings_json',
  'lorebook_json', 'state_definition_json', 'message_render_json', 'components',
  'stage_component', 'extensions_json', 'default_preset_id', 'default_api_model_config_id',
] as const;
const nullableJsonFields = new Set(['lorebook_json', 'state_definition_json', 'message_render_json', 'extensions_json']);
const nullableTextFields = new Set(['description', 'cover', 'stage_component', 'default_preset_id', 'default_api_model_config_id']);

function nonblank(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('INVALID_WORLD_FIELD: ' + field);
  return value.trim();
}

function inputKeys(input: object, allowed: readonly string[]): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new Error('INVALID_WORLD_FIELD: ' + key);
  }
}

function tagsFrom(input: readonly string[]): string[] {
  if (!Array.isArray(input)) throw new Error('INVALID_WORLD_TAGS');
  return [...new Set(input.map(name => nonblank(name, 'tags')))];
}

function contentValues(input: WorldContent): SQLInputValue[] {
  return contentFields.map(field => {
    const value = input[field];
    if (field === 'name' || field === 'spec_version') return nonblank(value, field);
    if (field === 'characters_json' || field === 'openings_json') return encodeJson(value, 'array');
    if (field === 'components') return value === null ? null : encodeJson(value, 'array');
    if (nullableJsonFields.has(field)) return value === null ? null : encodeJson(value);
    if (nullableTextFields.has(field)) {
      if (value === null) return null;
      if (typeof value !== 'string') throw new Error('INVALID_WORLD_FIELD: ' + field);
      if (field === 'default_preset_id' || field === 'default_api_model_config_id') return nonblank(value, field);
      return value;
    }
    throw new Error('INVALID_WORLD_FIELD: ' + field);
  });
}

function initialContent(input: CreateWorld): WorldContent {
  return {
    spec_version: input.spec_version,
    name: input.name,
    description: input.description ?? null,
    cover: input.cover ?? null,
    characters_json: input.characters_json,
    openings_json: input.openings_json,
    lorebook_json: input.lorebook_json ?? null,
    state_definition_json: input.state_definition_json ?? null,
    message_render_json: input.message_render_json ?? null,
    components: input.components ?? null,
    stage_component: input.stage_component ?? null,
    extensions_json: input.extensions_json ?? null,
    default_preset_id: input.default_preset_id ?? null,
    default_api_model_config_id: input.default_api_model_config_id ?? null,
  };
}

/** Owns world definitions, configuration references and ordered tag bindings. Runtime state belongs to StateRepository. */
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

  list({ tag, limit = 50, offset = 0 }: WorldListOptions = {}): WorldRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('INVALID_WORLD_PAGINATION');
    }
    const args: SQLInputValue[] = [];
    let filter = '';
    if (tag !== undefined) {
      filter = 'WHERE EXISTS (SELECT 1 FROM world_tags t WHERE t.world_id = w.id AND t.name = ?)';
      args.push(nonblank(tag, 'tag'));
    }
    args.push(limit, offset);
    const rows = this.db.prepare('SELECT w.id FROM worlds w ' + filter + ' ORDER BY w.updated_at DESC, w.id DESC LIMIT ? OFFSET ?').all(...args);
    return rows.map(row => this.get(String(row.id))!);
  }

  create(input: CreateWorld): WorldRecord {
    inputKeys(input, [...contentFields, 'id', 'state', 'tags']);
    const id = input.id ?? randomUUID();
    assertWorldId(id);
    const content = initialContent(input);
    const values = contentValues(content);
    const tags = tagsFrom(input.tags === undefined ? [] : input.tags);
    const state = encodeJson(input.state === undefined ? {} : input.state, 'object');
    return transaction(this.db, () => {
      if (content.default_preset_id !== null) assertNarrativePreset(this.db, content.default_preset_id);
      const now = Date.now();
      const columns = ['id', ...contentFields, 'state', 'created_at', 'updated_at'];
      this.db.prepare('INSERT INTO worlds (' + columns.join(', ') + ') VALUES (' + columns.map(() => '?').join(', ') + ')')
        .run(id, ...values, state, now, now);
      this.writeTags(id, tags);
      return this.get(id)!;
    });
  }

  update(id: string, patch: WorldPatch): WorldRecord | null {
    // Reject state even when a caller bypasses TypeScript: no read/modify/write of another module's column.
    inputKeys(patch, [...contentFields, 'tags']);
    return transaction(this.db, () => {
      const current = this.get(id);
      if (!current) return null;
      const changes = Object.entries(patch).filter(([, value]) => value !== undefined);
      if (!changes.length) return current;
      const next = { ...current, ...Object.fromEntries(changes) };
      const values = contentValues(next);
      const tags = patch.tags === undefined ? undefined : tagsFrom(patch.tags);
      if (next.default_preset_id !== null) assertNarrativePreset(this.db, next.default_preset_id);
      this.db.prepare('UPDATE worlds SET ' + contentFields.map(field => field + ' = ?').join(', ') + ', updated_at = ? WHERE id = ?')
        .run(...values, Date.now(), id);
      if (tags !== undefined) this.writeTags(id, tags);
      return this.get(id)!;
    });
  }

  setTags(id: string, tags: readonly string[]): WorldRecord | null {
    return this.update(id, { tags });
  }

  listTags(): WorldTag[] {
    return this.db.prepare('SELECT name, count(*) AS world_count FROM world_tags GROUP BY name ORDER BY name').all()
      .map(row => ({ name: String(row.name), world_count: Number(row.world_count) }));
  }

  delete(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM worlds WHERE id = ?').run(id).changes) > 0;
  }

  private writeTags(id: string, tags: readonly string[]): void {
    this.db.prepare('DELETE FROM world_tags WHERE world_id = ?').run(id);
    const insert = this.db.prepare('INSERT INTO world_tags (world_id, name, sort_order) VALUES (?, ?, ?)');
    tags.forEach((name, index) => insert.run(id, name, index));
  }
}
