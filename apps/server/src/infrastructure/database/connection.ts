import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from '../../errors.js';

export const DATABASE_VERSION = 12;
export const DATABASE_APPLICATION_ID = 0x53525632; // SRV2; distinct from the old Server database.
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

const SCHEMA_SQL = `
CREATE TABLE api_model_configs (
    id             TEXT PRIMARY KEY NOT NULL,
    name           TEXT NOT NULL,
    provider_id    TEXT NOT NULL,
    model_id       TEXT NOT NULL,
    credential_ref TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);

CREATE TABLE presets (
    id          TEXT PRIMARY KEY NOT NULL,
    type        TEXT NOT NULL CHECK(length(trim(type)) > 0),
    name        TEXT NOT NULL CHECK(length(trim(name)) > 0),
    description TEXT,
    config_json TEXT NOT NULL
                CHECK(json_valid(config_json) AND json_type(config_json) = 'object'),
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE(type, name)
);

CREATE TABLE worlds (
    id                          TEXT PRIMARY KEY NOT NULL,
    spec_version                TEXT NOT NULL,
    name                        TEXT NOT NULL,
    description                 TEXT,
    cover                       TEXT,
    characters_json             TEXT NOT NULL
                                CHECK(json_valid(characters_json) AND json_type(characters_json) = 'array'),
    openings_json               TEXT NOT NULL
                                CHECK(json_valid(openings_json) AND json_type(openings_json) = 'array'),
    lorebook_json                TEXT CHECK(lorebook_json IS NULL OR json_valid(lorebook_json)),
    state_definition_json       TEXT CHECK(state_definition_json IS NULL OR json_valid(state_definition_json)),
    message_render_json         TEXT CHECK(message_render_json IS NULL OR json_valid(message_render_json)),
    components                  TEXT CHECK(components IS NULL OR (json_valid(components) AND json_type(components) = 'array')),
    stage_component             TEXT,
    extensions_json             TEXT CHECK(extensions_json IS NULL OR json_valid(extensions_json)),
    default_preset_id           TEXT REFERENCES presets(id) ON DELETE RESTRICT,
    default_api_model_config_id TEXT REFERENCES api_model_configs(id) ON DELETE RESTRICT,
    state                       TEXT NOT NULL CHECK(json_valid(state) AND json_type(state) = 'object'),
    created_at                  INTEGER NOT NULL,
    updated_at                  INTEGER NOT NULL
);

CREATE TABLE world_tags (
    world_id   TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    name       TEXT NOT NULL CHECK(length(trim(name)) > 0),
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(world_id, name)
);

CREATE TABLE sessions (
    id                  TEXT PRIMARY KEY NOT NULL,
    world_id            TEXT NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
    preset_id           TEXT NOT NULL REFERENCES presets(id) ON DELETE RESTRICT,
    api_model_config_id TEXT NOT NULL REFERENCES api_model_configs(id) ON DELETE RESTRICT,
    user_character_id   TEXT NOT NULL,
    tip_entry_id        TEXT,
    title               TEXT,
    state               TEXT NOT NULL CHECK(json_valid(state) AND json_type(state) = 'object'),
    usage_json          TEXT CHECK(usage_json IS NULL OR (json_valid(usage_json) AND json_type(usage_json) = 'object')),
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
);

CREATE TABLE entries (
    id           TEXT PRIMARY KEY NOT NULL,
    session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    parent_id    TEXT,
    run_id       TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    type         TEXT NOT NULL CHECK(type IN ('message', 'compaction')),
    role         TEXT,
    timestamp    INTEGER NOT NULL,
    payload      TEXT NOT NULL CHECK(json_valid(payload) AND json_type(payload) = 'object'),
    state        TEXT CHECK(state IS NULL OR (json_valid(state) AND json_type(state) = 'array')),
    ext_data     TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(ext_data) AND json_type(ext_data) = 'object'),
    metrics_json TEXT CHECK(metrics_json IS NULL OR (json_valid(metrics_json) AND json_type(metrics_json) = 'object')),
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    UNIQUE(session_id, seq),
    CHECK(
        (type = 'message' AND role IN ('user', 'assistant') AND role IS NOT NULL)
        OR (type = 'compaction' AND role IS NULL)
    )
);

CREATE TABLE app_settings (
    id                          INTEGER PRIMARY KEY CHECK(id = 1),
    default_preset_id           TEXT REFERENCES presets(id) ON DELETE RESTRICT,
    default_api_model_config_id TEXT REFERENCES api_model_configs(id) ON DELETE RESTRICT,
    created_at                  INTEGER NOT NULL,
    updated_at                  INTEGER NOT NULL
);

CREATE INDEX idx_worlds_updated ON worlds(updated_at, id);
CREATE INDEX idx_world_preset ON worlds(default_preset_id);
CREATE INDEX idx_world_model ON worlds(default_api_model_config_id);
CREATE INDEX idx_world_tags_name ON world_tags(name, world_id);
CREATE INDEX idx_presets_type_created ON presets(type, created_at, id);
CREATE INDEX idx_sessions_world_updated ON sessions(world_id, updated_at, id);
CREATE INDEX idx_sessions_updated ON sessions(updated_at, id);
CREATE INDEX idx_session_preset ON sessions(preset_id);
CREATE INDEX idx_session_model ON sessions(api_model_config_id);
CREATE INDEX idx_entries_parent ON entries(session_id, parent_id);
CREATE INDEX idx_entries_run ON entries(session_id, run_id, seq);
CREATE INDEX idx_entries_role ON entries(session_id, role, seq);
`;

const UPGRADE_V2_SQL = 'ALTER TABLE presets ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0)';

const UPGRADE_V3_SQL = 'ALTER TABLE worlds ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0); CREATE INDEX idx_worlds_created ON worlds(created_at, id)';

const UPGRADE_V4_SQL = 'CREATE INDEX idx_entries_state_seq ON entries(session_id, seq) WHERE state IS NOT NULL';

const UPGRADE_V5_SQL = "ALTER TABLE app_settings ADD COLUMN locale TEXT NOT NULL DEFAULT 'zh-CN' CHECK(locale IN ('zh-CN','en'))";

// app_settings has no incoming references; rebuilding its CHECK keeps every stored value.
const UPGRADE_V6_SQL = `
ALTER TABLE app_settings RENAME TO app_settings_v5;
CREATE TABLE app_settings (
    id                          INTEGER PRIMARY KEY CHECK(id = 1),
    default_preset_id           TEXT REFERENCES presets(id) ON DELETE RESTRICT,
    default_api_model_config_id TEXT REFERENCES api_model_configs(id) ON DELETE RESTRICT,
    created_at                  INTEGER NOT NULL,
    updated_at                  INTEGER NOT NULL,
    locale                      TEXT NOT NULL DEFAULT 'zh-CN' CHECK(locale IN ('zh-CN','en','ja'))
);
INSERT INTO app_settings(id,default_preset_id,default_api_model_config_id,created_at,updated_at,locale)
SELECT id,default_preset_id,default_api_model_config_id,created_at,updated_at,locale FROM app_settings_v5;
DROP TABLE app_settings_v5;
`;

const UPGRADE_V7_SQL = `
ALTER TABLE presets ADD COLUMN api_model_config_id TEXT REFERENCES api_model_configs(id) ON DELETE RESTRICT;
ALTER TABLE app_settings ADD COLUMN default_reply_assist_preset_id TEXT REFERENCES presets(id) ON DELETE RESTRICT;
ALTER TABLE sessions ADD COLUMN reply_assist_goal TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_presets_model ON presets(api_model_config_id);
`;

const UPGRADE_V8_SQL = 'ALTER TABLE sessions ADD COLUMN reply_assist_preset_id TEXT REFERENCES presets(id) ON DELETE RESTRICT';

// Old sessions and their cascading entries are intentionally discarded once.
// Virtual keys preserve database reference constraints without storing duplicate configuration.
const UPGRADE_V9_SQL = `
DROP TABLE sessions;
CREATE TABLE sessions (
    id                  TEXT PRIMARY KEY NOT NULL,
    world_id            TEXT NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
    runtime_config      TEXT NOT NULL CHECK(json_valid(runtime_config) AND json_type(runtime_config) = 'object'),
    narrative_preset_ref TEXT GENERATED ALWAYS AS (json_extract(runtime_config,'$.narrative_preset_id')) VIRTUAL NOT NULL REFERENCES presets(id) ON DELETE RESTRICT,
    reply_preset_ref     TEXT GENERATED ALWAYS AS (json_extract(runtime_config,'$.reply_assist_preset_id')) VIRTUAL REFERENCES presets(id) ON DELETE RESTRICT,
    model_ref            TEXT GENERATED ALWAYS AS (json_extract(runtime_config,'$.api_model_config_id')) VIRTUAL NOT NULL REFERENCES api_model_configs(id) ON DELETE RESTRICT,
    user_character_id   TEXT NOT NULL,
    tip_entry_id        TEXT,
    title               TEXT,
    state               TEXT NOT NULL CHECK(json_valid(state) AND json_type(state) = 'object'),
    usage_json          TEXT CHECK(usage_json IS NULL OR (json_valid(usage_json) AND json_type(usage_json) = 'object')),
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
);
CREATE INDEX idx_sessions_world_updated ON sessions(world_id, updated_at, id);
CREATE INDEX idx_sessions_updated ON sessions(updated_at, id);
CREATE INDEX idx_session_preset ON sessions(narrative_preset_ref);
CREATE INDEX idx_session_model ON sessions(model_ref);
CREATE INDEX idx_session_reply_preset ON sessions(reply_preset_ref);
`;

const UPGRADE_V10_SQL = "ALTER TABLE app_settings ADD COLUMN cover_mosaic_density INTEGER NOT NULL DEFAULT 24 CHECK(typeof(cover_mosaic_density) = 'integer' AND cover_mosaic_density BETWEEN 8 AND 64)";

const UPGRADE_V11_SQL = `
ALTER TABLE worlds ADD COLUMN default_reply_assist_preset_id TEXT REFERENCES presets(id) ON DELETE RESTRICT;
CREATE INDEX idx_world_reply_preset ON worlds(default_reply_assist_preset_id);
`;

const UPGRADE_V12_SQL = "ALTER TABLE worlds ADD COLUMN publication_json TEXT CHECK(publication_json IS NULL OR (json_valid(publication_json) AND json_type(publication_json) = 'object'))";

// Apply identical migration SQL to reference, new and upgraded databases.
function expectedObjects(version: number) {
  const reference = new DatabaseSync(':memory:');
  try {
    reference.exec(SCHEMA_SQL);
    if (version >= 2) reference.exec(UPGRADE_V2_SQL);
    if (version >= 3) reference.exec(UPGRADE_V3_SQL);
    if (version >= 4) reference.exec(UPGRADE_V4_SQL);
    if (version >= 5) reference.exec(UPGRADE_V5_SQL);
    if (version >= 6) reference.exec(UPGRADE_V6_SQL);
    if (version >= 7) reference.exec(UPGRADE_V7_SQL);
    if (version >= 8) reference.exec(UPGRADE_V8_SQL);
    if (version >= 9) reference.exec(UPGRADE_V9_SQL);
    if (version >= 10) reference.exec(UPGRADE_V10_SQL);
    if (version >= 11) reference.exec(UPGRADE_V11_SQL);
    if (version >= 12) reference.exec(UPGRADE_V12_SQL);
    return new Map(reference.prepare("SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
      .all().map(row => [String(row.name), String(row.sql)]));
  } finally { reference.close(); }
}
const schemas = new Map([[1, expectedObjects(1)], [2, expectedObjects(2)], [3, expectedObjects(3)], [4, expectedObjects(4)], [5, expectedObjects(5)], [6, expectedObjects(6)], [7, expectedObjects(7)], [8, expectedObjects(8)], [9, expectedObjects(9)], [10, expectedObjects(10)], [11, expectedObjects(11)], [12, expectedObjects(12)]]);
const normalizeSql = (sql: string) => sql.replace(/\s+/g, ' ').trim().toLowerCase();

function inspectDatabase(db: DatabaseSync) {
  return {
    version: Number(db.prepare('PRAGMA user_version').get()?.user_version),
    applicationId: Number(db.prepare('PRAGMA application_id').get()?.application_id),
    objects: db.prepare("SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all(),
  };
}

function isEmpty(info: ReturnType<typeof inspectDatabase>) {
  return info.version === 0 && info.applicationId === 0 && info.objects.length === 0;
}

function assertCompatible(info: ReturnType<typeof inspectDatabase>) {
  if (!schemas.has(info.version) || info.applicationId !== DATABASE_APPLICATION_ID) {
    throw new Error('SERVER_DATABASE_INCOMPATIBLE: expected an independent V2 database at version '
      + DATABASE_VERSION + ', found version ' + info.version + ' (application_id=' + info.applicationId
      + '). Choose a V2 data directory; the existing database was not migrated or reset.');
  }
  const expectedSchema = schemas.get(info.version)!;
  if (info.objects.length !== expectedSchema.size || info.objects.some(row =>
    !expectedSchema.has(String(row.name))
    || normalizeSql(String(row.sql)) !== normalizeSql(expectedSchema.get(String(row.name))!))) {
    throw new Error('SERVER_DATABASE_SCHEMA_MISMATCH: the V2 schema is incomplete or different; no automatic repair was performed');
  }
}

/** Open a verified V2 database and apply only known migrations. The caller owns close(). */
export function openDatabase(path: string): DatabaseSync {
  if (typeof path !== 'string' || !path.trim()) throw new Error('SERVER_DATABASE_PATH_REQUIRED');
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON');
    const initial = inspectDatabase(db);
    if (!isEmpty(initial)) assertCompatible(initial);
    if (isEmpty(initial) || initial.version < DATABASE_VERSION) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = inspectDatabase(db);
        if (isEmpty(current)) {
          db.exec(SCHEMA_SQL);
          db.exec(UPGRADE_V2_SQL);
          db.exec(UPGRADE_V3_SQL);
          db.exec(UPGRADE_V4_SQL);
          db.exec(UPGRADE_V5_SQL);
          db.exec(UPGRADE_V6_SQL);
          db.exec(UPGRADE_V7_SQL);
          db.exec(UPGRADE_V8_SQL);
          db.exec(UPGRADE_V9_SQL);
          db.exec(UPGRADE_V10_SQL);
          db.exec(UPGRADE_V11_SQL);
          db.exec(UPGRADE_V12_SQL);
          db.exec('PRAGMA application_id=' + DATABASE_APPLICATION_ID);
        } else {
          assertCompatible(current);
          if (current.version === 1) db.exec(UPGRADE_V2_SQL);
          if (current.version < 3) db.exec(UPGRADE_V3_SQL);
          if (current.version < 4) db.exec(UPGRADE_V4_SQL);
          if (current.version < 5) db.exec(UPGRADE_V5_SQL);
          if (current.version < 6) db.exec(UPGRADE_V6_SQL);
          if (current.version < 7) db.exec(UPGRADE_V7_SQL);
          if (current.version < 8) db.exec(UPGRADE_V8_SQL);
          if (current.version < 9) db.exec(UPGRADE_V9_SQL);
          if (current.version < 10) db.exec(UPGRADE_V10_SQL);
          if (current.version < 11) db.exec(UPGRADE_V11_SQL);
          if (current.version < 12) db.exec(UPGRADE_V12_SQL);
        }
        db.exec('PRAGMA user_version=' + DATABASE_VERSION);
        assertCompatible(inspectDatabase(db));
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    db.exec('PRAGMA journal_mode=WAL');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Serialize a validated data snapshot, never getters or a caller's toJSON hook. */
export function encodeJson(value: unknown, kind?: 'object' | 'array'): string {
  const ancestors = new Set<object>();
  const snapshot = (item: unknown): JsonValue => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object' || item === null) throw new AppError('INVALID_JSON_VALUE');
    if (ancestors.has(item)) throw new AppError('CYCLIC_JSON_VALUE');
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype))
      throw new AppError('INVALID_JSON_OBJECT');

    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.getOwnPropertySymbols(descriptors).length) throw new AppError('INVALID_JSON_KEY');
    ancestors.add(item);
    try {
      if (array) {
        const length = descriptors.length!.value as number;
        if (Object.keys(descriptors).length !== length + 1) throw new AppError('INVALID_JSON_ARRAY');
        const copy: JsonValue[] = [];
        Object.setPrototypeOf(copy, null);
        for (let index = 0; index < length; index++) {
          const descriptor = descriptors[String(index)];
          if (!descriptor) throw new AppError('INVALID_JSON_ARRAY');
          if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new AppError('INVALID_JSON_PROPERTY');
          copy[index] = snapshot(descriptor.value);
        }
        return copy;
      }

      const copy: JsonObject = Object.create(null);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new AppError('INVALID_JSON_PROPERTY');
        copy[key] = snapshot(descriptor.value);
      }
      return copy;
    } finally {
      ancestors.delete(item);
    }
  };
  if (kind === 'array' && !Array.isArray(value)) throw new AppError('JSON_ARRAY_REQUIRED');
  if (kind === 'object' && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    throw new AppError('JSON_OBJECT_REQUIRED');
  }
  return JSON.stringify(snapshot(value));
}
