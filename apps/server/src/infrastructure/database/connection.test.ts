import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DATABASE_APPLICATION_ID, DATABASE_VERSION, encodeJson, openDatabase } from './connection.js';
import { transaction } from './transaction.js';

describe('V2 database lifecycle and constraints', () => {
  let db: DatabaseSync;
  const directories: string[] = [];
  beforeEach(() => { db = openDatabase(':memory:'); });
  afterEach(() => {
    db.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });
  const file = () => {
    const directory = mkdtempSync(join(tmpdir(), 'sr-v2-database-'));
    directories.push(directory);
    return join(directory, 'nested', 'database.sqlite');
  };

  function legacyWorldDefaults(database: DatabaseSync) {
    database.exec('DROP INDEX idx_world_reply_preset; ALTER TABLE worlds DROP COLUMN default_reply_assist_preset_id');
  }

  // Recreate the historical table before inserting fixtures. DROP COLUMN on V6's
  // rebuilt table does not reproduce the exact SQL text of the validated old schema.
  function legacySettings(database: DatabaseSync, includeLocale = false) {
    legacyWorldDefaults(database);
    database.exec(`
DROP INDEX idx_presets_model;
ALTER TABLE presets DROP COLUMN api_model_config_id;
DROP TABLE sessions;
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
CREATE INDEX idx_sessions_world_updated ON sessions(world_id, updated_at, id);
CREATE INDEX idx_sessions_updated ON sessions(updated_at, id);
CREATE INDEX idx_session_preset ON sessions(preset_id);
CREATE INDEX idx_session_model ON sessions(api_model_config_id);
DROP TABLE app_settings;
CREATE TABLE app_settings (
    id                          INTEGER PRIMARY KEY CHECK(id = 1),
    default_preset_id           TEXT REFERENCES presets(id) ON DELETE RESTRICT,
    default_api_model_config_id TEXT REFERENCES api_model_configs(id) ON DELETE RESTRICT,
    created_at                  INTEGER NOT NULL,
    updated_at                  INTEGER NOT NULL
);
`);
    if (includeLocale) {
      database.exec("ALTER TABLE app_settings ADD COLUMN locale TEXT NOT NULL DEFAULT 'zh-CN' CHECK(locale IN ('zh-CN','en'))");
    }
  }

  function seedSession() {
    db.prepare('INSERT INTO api_model_configs VALUES(?,?,?,?,?,?,?)').run('m', 'Model', 'provider', 'model', 'credential-ref', 1, 1);
    db.prepare('INSERT INTO presets(id,type,name,description,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('p', 'narrative', 'Preset', null, '{}', 1, 1);
  }

  it('initializes the seven tables without inserting business data', () => {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    expect(tables.map(row => row.name)).toEqual(['api_model_configs', 'app_settings', 'entries', 'presets', 'sessions', 'world_tags', 'worlds']);
    expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(DATABASE_VERSION);
    expect(db.prepare('PRAGMA application_id').get()?.application_id).toBe(DATABASE_APPLICATION_ID);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger'").all()).toEqual([]);
    expect(db.prepare('SELECT * FROM app_settings').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM presets').all()).toEqual([]);
  });

  it('reopens persisted values without reseeding or mutating application content', () => {
    const path = file();
    const first = openDatabase(path);
    first.prepare('INSERT INTO app_settings(id,default_preset_id,default_api_model_config_id,created_at,updated_at) VALUES(1,NULL,NULL,123,123)').run();
    first.close();
    const second = openDatabase(path);
    try { expect(second.prepare('SELECT updated_at FROM app_settings WHERE id=1').get()?.updated_at).toBe(123); }
    finally { second.close(); }
  });

  it('upgrades a verified V1 database without reseeding data and reopens the V2 schema', () => {
    const path = file();
    const previous = openDatabase(path);
    legacySettings(previous);
    previous.exec("ALTER TABLE presets DROP COLUMN revision; ALTER TABLE worlds DROP COLUMN revision; DROP INDEX idx_worlds_created; DROP INDEX idx_entries_state_seq; PRAGMA user_version=1; INSERT INTO app_settings(id,default_preset_id,default_api_model_config_id,created_at,updated_at) VALUES(1,NULL,NULL,123,123)");
    previous.prepare('INSERT INTO presets(id,type,name,description,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('preserved', 'narrative', 'Keep', null, '{}', 7, 8);
    previous.close();
    const upgraded = openDatabase(path);
    expect(upgraded.prepare('SELECT revision,name,created_at FROM presets').get()).toMatchObject({ revision: 1, name: 'Keep', created_at: 7 });
    expect(upgraded.prepare('SELECT default_preset_id,updated_at FROM app_settings').get()).toMatchObject({ default_preset_id: null, updated_at: 123 });
    upgraded.close();
    const reopened = openDatabase(path);
    expect(reopened.prepare('PRAGMA user_version').get()?.user_version).toBe(DATABASE_VERSION);
    reopened.close();
  });

  it('upgrades V2 worlds in place and keeps their content and timestamps', () => {
    const path = file();
    const previous = openDatabase(path);
    legacySettings(previous);
    previous.exec("ALTER TABLE worlds DROP COLUMN revision; DROP INDEX idx_worlds_created; DROP INDEX idx_entries_state_seq; PRAGMA user_version=2");
    previous.prepare("INSERT INTO worlds(id,spec_version,name,characters_json,openings_json,state,created_at,updated_at) VALUES('w','0.1','Keep','[]','[]','{\"coins\":7}',10,20)").run();
    previous.exec("INSERT INTO world_tags VALUES('w','tag',0)");
    previous.close();
    const upgraded = openDatabase(path);
    expect(upgraded.prepare('SELECT revision,name,state,created_at,updated_at FROM worlds').get()).toMatchObject({ revision: 1, name: 'Keep', state: '{"coins":7}', created_at: 10, updated_at: 20 });
    expect(upgraded.prepare('SELECT name FROM world_tags').get()?.name).toBe('tag');
    upgraded.close();
    const reopened = openDatabase(path);
    expect(reopened.prepare('PRAGMA user_version').get()?.user_version).toBe(DATABASE_VERSION);
    reopened.close();
  });

  it.each([3, 4])('adds the default locale to V%s without changing existing settings or world content', version => {
    const path = file();
    const previous = openDatabase(path);
    legacySettings(previous);
    if (version === 3) previous.exec('DROP INDEX idx_entries_state_seq');
    previous.exec('PRAGMA user_version=' + version);
    previous.prepare("INSERT INTO presets(id,type,name,description,config_json,created_at,updated_at) VALUES('keep','narrative','Custom',NULL,'{}',7,8)").run();
    previous.prepare("INSERT INTO app_settings(id,default_preset_id,default_api_model_config_id,created_at,updated_at) VALUES(1,'keep',NULL,11,12)").run();
    previous.prepare("INSERT INTO worlds(id,spec_version,name,characters_json,openings_json,state,created_at,updated_at) VALUES('w','0.1','Keep','[]','[]','{}',13,14)").run();
    const originalSettings = previous.prepare('SELECT * FROM app_settings').get();
    const originalPreset = previous.prepare('SELECT * FROM presets').get();
    const originalWorld = previous.prepare('SELECT * FROM worlds').get();
    previous.close();

    const upgraded = openDatabase(path);
    expect(upgraded.prepare('SELECT * FROM app_settings').get()).toEqual({ ...originalSettings, locale: 'zh-CN', default_reply_assist_preset_id: null, cover_mosaic_density: 24 });
    expect(upgraded.prepare('SELECT * FROM presets').get()).toEqual({ ...originalPreset, api_model_config_id: null });
    expect(upgraded.prepare('SELECT * FROM worlds').get()).toEqual({ ...originalWorld, default_reply_assist_preset_id: null });
    expect(upgraded.prepare('PRAGMA user_version').get()?.user_version).toBe(DATABASE_VERSION);
    expect(() => upgraded.prepare("UPDATE app_settings SET locale='fr'").run()).toThrow();
    upgraded.prepare("UPDATE app_settings SET locale='en'").run();
    upgraded.close();

    const reopened = openDatabase(path);
    expect(reopened.prepare('SELECT locale,created_at,updated_at FROM app_settings').get())
      .toEqual({ locale: 'en', created_at: 11, updated_at: 12 });
    reopened.close();
  });

  it.each(['zh-CN', 'en'])('upgrades a V5 %s database to Japanese support and discards only the old sessions and entries', locale => {
    const path = file();
    const previous = openDatabase(path);
    legacySettings(previous, true);
    previous.exec('PRAGMA user_version=5');
    previous.prepare('INSERT INTO api_model_configs VALUES(?,?,?,?,?,?,?)')
      .run('m', 'Model', 'provider', 'model', 'credential-ref', 5, 6);
    previous.prepare('INSERT INTO presets(id,type,name,description,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('p', 'narrative', 'Custom preset', 'Keep this', '{}', 7, 8);
    previous.prepare('INSERT INTO app_settings(id,default_preset_id,default_api_model_config_id,created_at,updated_at,locale) VALUES(?,?,?,?,?,?)')
      .run(1, 'p', 'm', 11, 12, locale);
    previous.prepare('INSERT INTO worlds(id,spec_version,name,characters_json,openings_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('w', '0.1', 'World', '[]', '[]', '{"day":2}', 13, 14);
    previous.prepare('INSERT INTO world_tags VALUES(?,?,?)').run('w', 'keep-tag', 0);
    previous.prepare('INSERT INTO sessions(id,world_id,preset_id,api_model_config_id,user_character_id,tip_entry_id,title,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run('s', 'w', 'p', 'm', 'player', 'entry', 'Keep session', '{"coins":7}', 15, 16);
    previous.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,timestamp,payload,state,ext_data,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('entry', 's', null, 'run', 1, 'message', 'assistant', 17, '{"message":{"content":"Keep narrative"}}', '[{"key":"coins","value":7}]', '{"keep":true}', 18, 19);
    const tables = ['api_model_configs', 'presets', 'app_settings', 'worlds', 'world_tags', 'sessions', 'entries'];
    const records = new Map(tables.map(table => [table, previous.prepare('SELECT * FROM ' + table).all().map(row => ({
      ...row,
      ...(table === 'app_settings' ? { default_reply_assist_preset_id: null, cover_mosaic_density: 24 } : {}),
      ...(table === 'presets' ? { api_model_config_id: null } : {}),
      ...(table === 'worlds' ? { default_reply_assist_preset_id: null } : {}),
    }))]));
    records.set('sessions', []);
    records.set('entries', []);
    expect(() => previous.prepare("UPDATE app_settings SET locale='ja'").run()).toThrow();
    previous.close();

    const upgraded = openDatabase(path);
    for (const table of tables) expect(upgraded.prepare('SELECT * FROM ' + table).all()).toEqual(records.get(table));
    expect(upgraded.prepare('PRAGMA user_version').get()?.user_version).toBe(DATABASE_VERSION);
    expect(upgraded.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(upgraded.prepare("SELECT name FROM sqlite_schema WHERE name='app_settings_v5'").get()).toBeUndefined();
    upgraded.prepare("UPDATE app_settings SET locale='ja'").run();
    expect(() => upgraded.prepare("UPDATE app_settings SET locale='fr'").run()).toThrow();
    upgraded.close();

    const reopened = openDatabase(path);
    expect(reopened.prepare('SELECT * FROM app_settings').get()).toEqual({ ...records.get('app_settings')![0], locale: 'ja' });
    for (const table of tables.filter(table => table !== 'app_settings')) {
      expect(reopened.prepare('SELECT * FROM ' + table).all()).toEqual(records.get(table));
    }
    reopened.close();
  });

  it.each([9, 10])('adds world reply defaults to a verified V%s database without changing existing rows', version => {
    const path = file();
    const previous = openDatabase(path);
    legacyWorldDefaults(previous);
    if (version === 9) previous.exec('ALTER TABLE app_settings DROP COLUMN cover_mosaic_density');
    previous.exec('PRAGMA user_version=' + version);
    previous.prepare('INSERT INTO api_model_configs VALUES(?,?,?,?,?,?,?)')
      .run('m', 'Model', 'provider', 'model', 'credential-ref', 5, 6);
    previous.prepare('INSERT INTO presets(id,type,name,description,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('p', 'narrative', 'Custom preset', 'Keep this', '{}', 7, 8);
    previous.prepare('INSERT INTO app_settings(id,default_preset_id,default_api_model_config_id,created_at,updated_at,locale) VALUES(?,?,?,?,?,?)')
      .run(1, 'p', 'm', 11, 12, 'ja');
    if (version === 10) previous.prepare('UPDATE app_settings SET cover_mosaic_density=11 WHERE id=1').run();
    previous.prepare('INSERT INTO worlds(id,spec_version,name,characters_json,openings_json,state,extensions_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('w', '0.1', 'World', '[]', '[]', '{"day":2}', '{"cover_mosaic_enabled":true,"creator":"keep"}', 13, 14);
    previous.prepare('INSERT INTO world_tags VALUES(?,?,?)').run('w', 'keep-tag', 0);
    previous.prepare('INSERT INTO sessions(id,world_id,runtime_config,user_character_id,tip_entry_id,title,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('s', 'w', JSON.stringify({ narrative_preset_id: 'p', api_model_config_id: 'm', reply_assist_preset_id: null, replay_assist_goal: 'Keep goal', font_size: 18 }),
        'player', 'entry', 'Keep session', '{"coins":7}', 15, 16);
    previous.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,timestamp,payload,state,ext_data,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('entry', 's', null, 'run', 1, 'message', 'assistant', 17, '{"message":{"content":"Keep narrative"}}', '[{"key":"coins","value":7}]', '{"keep":true}', 18, 19);
    const tables = ['api_model_configs', 'presets', 'app_settings', 'worlds', 'world_tags', 'sessions', 'entries'];
    const records = new Map(tables.map(table => [table, previous.prepare('SELECT * FROM ' + table).all().map(row => ({
      ...row,
      ...(table === 'app_settings' && version === 9 ? { cover_mosaic_density: 24 } : {}),
      ...(table === 'worlds' ? { default_reply_assist_preset_id: null } : {}),
    }))]));
    previous.close();

    const upgraded = openDatabase(path);
    for (const table of tables) expect(upgraded.prepare('SELECT * FROM ' + table).all()).toEqual(records.get(table));
    expect(upgraded.prepare('PRAGMA user_version').get()?.user_version).toBe(DATABASE_VERSION);
    expect(upgraded.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(() => upgraded.prepare("UPDATE worlds SET default_reply_assist_preset_id='missing' WHERE id='w'").run()).toThrow();
    upgraded.prepare("INSERT INTO presets(id,type,name,description,config_json,created_at,updated_at) VALUES('reply','reply_assist','World reply',NULL,'{}',21,22)").run();
    upgraded.prepare("UPDATE worlds SET default_reply_assist_preset_id='reply' WHERE id='w'").run();
    expect(() => upgraded.prepare("DELETE FROM presets WHERE id='reply'").run()).toThrow();
    upgraded.prepare("UPDATE worlds SET default_reply_assist_preset_id=NULL WHERE id='w'").run();
    upgraded.prepare("DELETE FROM presets WHERE id='reply'").run();
    upgraded.prepare('UPDATE app_settings SET cover_mosaic_density=64 WHERE id=1').run();
    upgraded.close();

    const reopened = openDatabase(path);
    expect(reopened.prepare('SELECT * FROM app_settings').get()).toEqual({ ...records.get('app_settings')![0], cover_mosaic_density: 64 });
    for (const table of tables.filter(table => table !== 'app_settings')) {
      expect(reopened.prepare('SELECT * FROM ' + table).all()).toEqual(records.get(table));
    }
    reopened.close();
  });

  it.each([0, 1, 7, 99])('refuses an unrelated or old version %s database without altering it', version => {
    const path = join(mkdtempSync(join(tmpdir(), 'sr-old-database-')), 'old.sqlite');
    directories.push(join(path, '..'));
    const old = new DatabaseSync(path);
    old.exec('CREATE TABLE user_data(value TEXT); INSERT INTO user_data VALUES(\'keep me\'); PRAGMA user_version=' + version);
    old.close();
    const bytes = readFileSync(path);
    expect(() => openDatabase(path)).toThrow('SERVER_DATABASE_INCOMPATIBLE');
    expect(readFileSync(path)).toEqual(bytes);
  });

  it('refuses a damaged V2 schema instead of recreating missing tables', () => {
    const path = file();
    const first = openDatabase(path);
    first.exec('DROP INDEX idx_world_tags_name');
    first.close();
    expect(() => openDatabase(path)).toThrow('SERVER_DATABASE_SCHEMA_MISMATCH');
    const untouched = new DatabaseSync(path, { readOnly: true });
    try { expect(untouched.prepare("SELECT name FROM sqlite_schema WHERE name='idx_world_tags_name'").get()).toBeUndefined(); }
    finally { untouched.close(); }
  });

  it('rolls back a nested operation without committing the surrounding transaction', () => {
    db.prepare('INSERT INTO app_settings(id,default_preset_id,default_api_model_config_id,created_at,updated_at) VALUES(1,NULL,NULL,1,1)').run();
    transaction(db, () => {
      db.prepare('UPDATE app_settings SET updated_at=10 WHERE id=1').run();
      expect(() => transaction(db, () => {
        db.prepare('UPDATE app_settings SET updated_at=20 WHERE id=1').run();
        throw new Error('inner failure');
      })).toThrow('inner failure');
      expect(db.prepare('SELECT updated_at FROM app_settings WHERE id=1').get()?.updated_at).toBe(10);
    });
    expect(() => transaction(db, () => {
      db.prepare('UPDATE app_settings SET updated_at=30 WHERE id=1').run();
      throw new Error('outer failure');
    })).toThrow('outer failure');
    expect(db.prepare('SELECT updated_at FROM app_settings WHERE id=1').get()?.updated_at).toBe(10);
  });

  it('enforces references, JSON shapes, unique names and message roles at the SQL boundary', () => {
    seedSession();
    expect(() => db.prepare('INSERT INTO presets(id,type,name,description,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('p2', 'narrative', 'Preset', null, '{}', 1, 1)).toThrow();
    expect(() => db.prepare('INSERT INTO presets(id,type,name,description,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('p2', 'narrative', 'Other', null, '[]', 1, 1)).toThrow();
    db.prepare("INSERT INTO worlds(id,spec_version,name,characters_json,openings_json,state,created_at,updated_at) VALUES('w','0.1','World','[]','[]','{}',1,1)").run();
    db.prepare("INSERT INTO world_tags VALUES('w','adventure',0)").run();
    db.prepare("INSERT INTO sessions(id,world_id,runtime_config,user_character_id,state,created_at,updated_at) VALUES('s','w',?,'player','{}',1,1)").run(
      JSON.stringify({ narrative_preset_id: 'p', api_model_config_id: 'm', reply_assist_preset_id: null, replay_assist_goal: '', font_size: 16 }));
    expect(db.prepare("SELECT usage_json FROM sessions WHERE id='s'").get()?.usage_json).toBeNull();
    expect(() => db.prepare("DELETE FROM worlds WHERE id='w'").run()).toThrow();
    expect(() => db.prepare("DELETE FROM presets WHERE id='p'").run()).toThrow();
    const insert = db.prepare('INSERT INTO entries(id,session_id,run_id,seq,type,role,timestamp,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
    expect(() => insert.run('e', 'missing', 'run', 1, 'message', 'user', 1, '{}', 1, 1)).toThrow();
    expect(() => insert.run('e', 's', 'run', 1, 'message', null, 1, '{}', 1, 1)).toThrow();
    expect(() => insert.run('e', 's', 'run', 1, 'compaction', 'assistant', 1, '{}', 1, 1)).toThrow();
    insert.run('e', 's', 'run', 1, 'message', 'assistant', 1, '{}', 1, 1);
    expect(() => insert.run('e2', 's', 'run', 1, 'compaction', null, 1, '{}', 1, 1)).toThrow();
    expect(() => db.prepare("UPDATE entries SET state='{}' WHERE id='e'").run()).toThrow();
    db.prepare("DELETE FROM sessions WHERE id='s'").run();
    expect(db.prepare('SELECT id FROM entries').all()).toEqual([]);
    db.prepare("DELETE FROM worlds WHERE id='w'").run();
    expect(db.prepare('SELECT world_id FROM world_tags').all()).toEqual([]);
  });
});

describe('JSON persistence', () => {
  it('retains explicit null and zero and allows shared but non-cyclic values', () => {
    const shared = { value: 0 };
    expect(JSON.parse(encodeJson({ a: shared, b: shared, unknown: null }, 'object')))
      .toEqual({ a: { value: 0 }, b: { value: 0 }, unknown: null });
    const dictionary = Object.assign(Object.create(null), { values: [shared, null, false] });
    expect(JSON.parse(encodeJson(dictionary, 'object'))).toEqual({ values: [{ value: 0 }, null, false] });
  });

  it('rejects hidden toJSON hooks and other non-enumerable fields instead of losing data', () => {
    const transformed = Object.defineProperty({ keep: 1 }, 'toJSON', { value: () => ({ replaced: true }) });
    const hidden = Object.defineProperty({}, 'keep', { value: 1 });
    expect(() => encodeJson(transformed, 'object')).toThrow('INVALID_JSON_PROPERTY');
    expect(() => encodeJson(hidden, 'object')).toThrow('INVALID_JSON_PROPERTY');
  });

  it('rejects getters without reading them, including getters on array elements', () => {
    let reads = 0;
    const accessor = () => ++reads === 1 ? 1 : undefined;
    const object = Object.defineProperty({}, 'keep', { enumerable: true, get: accessor });
    const array = Object.defineProperty([1], '0', { enumerable: true, get: accessor });
    expect(() => encodeJson(object, 'object')).toThrow('INVALID_JSON_PROPERTY');
    expect(() => encodeJson(array, 'array')).toThrow('INVALID_JSON_PROPERTY');
    expect(reads).toBe(0);
  });

  it('rejects values that JSON.stringify would silently lose or replace', () => {
    for (const value of [undefined, { missing: undefined }, { value: NaN }, [Infinity], new Date(), [1n], Array(2)]) {
      expect(() => encodeJson(value)).toThrow();
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => encodeJson(cyclic)).toThrow('CYCLIC_JSON_VALUE');
    expect(() => encodeJson({}, 'array')).toThrow('JSON_ARRAY_REQUIRED');
    expect(() => encodeJson([], 'object')).toThrow('JSON_OBJECT_REQUIRED');
  });
});
