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

  function seedSession() {
    db.prepare('INSERT INTO api_model_configs VALUES(?,?,?,?,?,?,?)').run('m', 'Model', 'provider', 'model', 'credential-ref', 1, 1);
    db.prepare('INSERT INTO presets(id,type,name,description,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('p', 'narrative', 'Preset', null, '{}', 1, 1);
  }

  it('initializes the eight tables without inserting business data', () => {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    expect(tables.map(row => row.name)).toEqual(['api_model_configs', 'app_settings', 'entries', 'presets', 'runs', 'sessions', 'world_tags', 'worlds']);
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

  it.each(Array.from({ length: DATABASE_VERSION - 1 }, (_, index) => index + 1))('rejects previous V%s databases without modifying their data', version => {
    const path = file();
    const previous = openDatabase(path);
    previous.prepare('INSERT INTO app_settings(id,created_at,updated_at) VALUES(1,123,456)').run();
    previous.exec('PRAGMA user_version=' + version);
    previous.close();
    const bytes = readFileSync(path);
    expect(() => openDatabase(path)).toThrow('SERVER_DATABASE_INCOMPATIBLE');
    expect(readFileSync(path)).toEqual(bytes);
    const untouched = new DatabaseSync(path, { readOnly: true });
    try {
      expect(untouched.prepare('PRAGMA user_version').get()?.user_version).toBe(version);
      expect(untouched.prepare('SELECT updated_at FROM app_settings').get()?.updated_at).toBe(456);
    } finally { untouched.close(); }
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

  it.each(['DROP TABLE runs','DROP INDEX idx_runs_session_page'])('rejects damaged current storage after %s', removal => {
    const path = file(), current = openDatabase(path);
    current.exec(removal);
    current.close();
    const before = readFileSync(path);
    expect(() => openDatabase(path)).toThrow('SERVER_DATABASE_SCHEMA_MISMATCH');
    expect(readFileSync(path)).toEqual(before);
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
    db.prepare("INSERT INTO worlds(id,spec_version,publication_json,name,characters_json,openings_json,state,created_at,updated_at) VALUES('w','0.2','{}','World','[]','[]','{}',1,1)").run();
    db.prepare("INSERT INTO world_tags VALUES('w','adventure',0)").run();
    db.prepare("INSERT INTO sessions(id,world_id,runtime_config,user_character_id,state,created_at,updated_at) VALUES('s','w',?,'player','{}',1,1)").run(
      JSON.stringify({ narrative_preset_id: 'p', api_model_config_id: 'm', reply_assist_preset_id: null, reply_assist_goal: '', font_size: 16 }));
    expect(() => db.prepare("DELETE FROM worlds WHERE id='w'").run()).toThrow();
    expect(() => db.prepare("DELETE FROM presets WHERE id='p'").run()).toThrow();
    const insert = db.prepare("INSERT INTO entries(id,session_id,run_id,seq,type,role,timestamp,payload,created_at,updated_at,status) VALUES(?,?,?,?,?,?,?,?,?,?,'complete')");
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
