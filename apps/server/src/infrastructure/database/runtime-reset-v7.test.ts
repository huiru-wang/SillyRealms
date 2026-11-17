import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import lockfile from 'proper-lockfile';
import { DATABASE_VERSION, openDatabase } from './database.js';
import { resetRuntimeData } from './runtime-reset.js';
import { compactRunMetadata } from './compact-run-metadata.js';
import { WorldFileStore } from '../world-files/world-file-store.js';

const directories: string[] = [];
const tables = ['api_model_configs', 'app_settings', 'worlds', 'sessions', 'entries', 'presets', 'tags', 'tag_assignments', 'run_preparations'];
function temporaryDirectory() {
  const dir = mkdtempSync(join(tmpdir(), 'sr-runtime-v7-'));
  directories.push(dir);
  return dir;
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function seedRetired() {
  const dir = temporaryDirectory(), path = join(dir, 'sillyrealms.sqlite');
  const source = join(dir, 'legacy-world.json');
  const definition = { schema_version: 1, scopes: {
    global: { shared: { type: 'number', initial: 1 } },
    session: { visits: { type: 'number', initial: 2 } },
    message: { score: { type: 'number', initial: 3 } },
  } };
  writeFileSync(source, JSON.stringify({ state: definition }));
  const db = openDatabase(path);
  try {
    const model = db.prepare('INSERT INTO api_model_configs VALUES(?,?,?,?,?,?,?)');
    model.run('model-a', 'Model A', 'fake', 'fake-a', 'test-credential-ref-a', 1, 2);
    model.run('model-b', 'Model B', 'fake', 'fake-b', 'test-credential-ref-b', 3, 4);
    db.prepare('UPDATE app_settings SET default_api_model_config_id=?,created_at=?,updated_at=?').run('model-b', 100, 101);
    db.prepare('UPDATE presets SET config_json=?').run(JSON.stringify({ nodes: [
      { id: 'worldState', prompt: '{{state.currentValues}}\n{{state.updateRules}}' },
    ] }));
    db.prepare('INSERT INTO worlds(id,spec,spec_version,name,characters_json,openings_json,state_definition_json,default_preset_id,default_api_model_config_id,state,source_file_path,source_kind,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('world', 'world_card', '0.1', 'Legacy world', '[]', '[]', JSON.stringify(definition),
        'sr-default-preset', 'model-a', '{"shared":10}', source, 'imported', 1, 1);
    db.prepare('INSERT INTO sessions(id,world_id,preset_id,api_model_config_id,user_character_id,tip_entry_id,title,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run('session', 'world', 'sr-default-preset', 'model-b', 'player', 'opening', 'Legacy session', '{"visits":20}', 1, 1);
    db.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,timestamp,payload,state,ext_data) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run('opening', 'session', null, 'opening-run', 1, 'message', 'assistant', 1,
        '{"message":{"role":"assistant","content":"Legacy opening"}}', '[{"key":"score","value":30}]', '{"origin":"opening"}');
    db.prepare('INSERT INTO run_preparations(run_id,session_id,request_id,expected_tip_entry_id,input_text,status,created_at) VALUES(?,?,?,?,?,?,?)')
      .run('run', 'session', 'request', 'opening', 'Old input', 'preparing', 1);
    const tag = db.prepare('INSERT INTO tags(id,type,name,created_at,updated_at) VALUES(?,?,?,?,?)');
    tag.run('world-tag', 'world', 'Old world tag', 1, 1);
    tag.run('preset-tag', 'preset', 'Old preset tag', 1, 1);
    const assignment = db.prepare('INSERT INTO tag_assignments(id,tag_id,target_id,created_at,updated_at) VALUES(?,?,?,?,?)');
    assignment.run('world-assignment', 'world-tag', 'world', 1, 1);
    assignment.run('preset-assignment', 'preset-tag', 'sr-default-preset', 1, 1);
    db.exec('PRAGMA user_version=6');
  } finally { db.close(); }
  return { dir, path, source };
}

function snapshot(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      version: Number(db.prepare('PRAGMA user_version').get()!.user_version),
      schema: db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),
      rows: Object.fromEntries(tables.map(table => [table, db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()])),
    };
  } finally { db.close(); }
}

describe('runtime database v7 gate', () => {
  it('initializes only an empty database and preserves a valid v7 database on reopen', () => {
    const path = join(temporaryDirectory(), 'sillyrealms.sqlite');
    const db = openDatabase(path);
    try {
      expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(DATABASE_VERSION);
      db.prepare('INSERT INTO api_model_configs VALUES(?,?,?,?,?,?,?)').run('model', 'Test', 'fake', 'fake', 'test-ref', 1, 1);
    } finally { db.close(); }
    const before = snapshot(path), reopened = openDatabase(path);
    reopened.close();
    expect(snapshot(path)).toEqual(before);
  });

  it('rejects populated v6 without changing data and includes the explicit reset command', () => {
    const { path } = seedRetired(), before = snapshot(path);
    expect(() => openDatabase(path)).toThrow(/DATABASE_RESET_REQUIRED.*reset:runtime/);
    expect(snapshot(path)).toEqual(before);
  });

  it.each([0, 5, 6, 8])('rejects nonempty unsupported v%i even without a worlds table', version => {
    const path = join(temporaryDirectory(), 'sillyrealms.sqlite'), db = new DatabaseSync(path);
    db.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('unchanged'); PRAGMA user_version="+version);
    db.close();
    const before = readFileSync(path);
    expect(() => openDatabase(path)).toThrow('DATABASE_RESET_REQUIRED');
    expect(readFileSync(path)).toEqual(before);
  });
});

describe('explicit v6 reset', () => {
  it('backs up old data, discards all worlds and state, and preserves model configuration and source files', async () => {
    const { dir, path, source } = seedRetired(), before = snapshot(path), sourceBefore = readFileSync(source);
    const result = await resetRuntimeData(dir, true);
    expect(result.schema).toBe(7);
    expect(result.removed).toEqual({ worlds: 1, sessions: 1, entries: 1, presets: 1, tags: 2, tag_assignments: 2, run_preparations: 1 });
    expect(result.backup).toContain('before-runtime-v7-');
    expect(result.worldFilesBackup).toBeNull();
    expect(snapshot(result.backup)).toEqual(before);
    expect(readFileSync(source)).toEqual(sourceBefore);
    const db = openDatabase(path);
    try {
      expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(7);
      for (const table of ['worlds', 'sessions', 'entries', 'tags', 'tag_assignments', 'run_preparations'])
        expect(db.prepare('SELECT count(*) AS n FROM '+table).get()!.n).toBe(0);
      expect(db.prepare('SELECT * FROM api_model_configs ORDER BY rowid').all()).toEqual(before.rows.api_model_configs);
      expect(db.prepare('SELECT * FROM app_settings').get()).toMatchObject({
        id: 1, default_preset_id: 'sr-default-preset', default_api_model_config_id: 'model-b', created_at: 100,
      });
      expect(db.prepare('SELECT m.id,m.credential_ref FROM app_settings a JOIN api_model_configs m ON m.id=a.default_api_model_config_id').get())
        .toMatchObject({ id: 'model-b', credential_ref: 'test-credential-ref-b' });
      const presets = db.prepare('SELECT id,config_json FROM presets').all();
      expect(presets).toHaveLength(1);
      expect(presets[0]!.id).toBe('sr-default-preset');
      expect(String(presets[0]!.config_json)).toContain('{{state.entries}}');
      expect(String(presets[0]!.config_json)).not.toMatch(/state\.(currentValues|updateRules)/);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(compactRunMetadata(db)).toEqual({ entries: 0, preparations: 0, bytesRemoved: 0 });
    } finally { db.close(); }
  });

  it('keeps source and package backups after real startup orphan cleanup removes the live world directory', async () => {
    const { dir, path } = seedRetired(), files = new WorldFileStore(dir), id = randomUUID();
    const source = Buffer.from('{"spec":"world_card","old":true}'), asset = Buffer.from([0, 1, 127, 255]);
    const saved = await files.save(id, source, 'world.json');
    const stage = await files.createPackageStage(id);
    mkdirSync(join(stage, 'assets'));
    writeFileSync(join(stage, 'world.json'), source);
    writeFileSync(join(stage, 'assets', 'image.bin'), asset);
    await files.publishPackage(id, stage);
    const legacy = new DatabaseSync(path);
    legacy.exec('PRAGMA foreign_keys=OFF');
    legacy.prepare('UPDATE worlds SET id=?,source_file_path=? WHERE id=?').run(id, saved.path, 'world');
    legacy.prepare('UPDATE sessions SET world_id=?').run(id);
    legacy.prepare("UPDATE tag_assignments SET target_id=? WHERE target_id='world'").run(id);
    legacy.close();
    const result = await resetRuntimeData(dir, true), backup = result.worldFilesBackup!;
    expect(backup).toBe(result.backup + '.world-files');
    expect(dirname(backup)).toBe(dir);
    expect(readFileSync(join(dir, saved.path))).toEqual(source);
    expect(readFileSync(join(backup, id, 'source', 'world.json'))).toEqual(source);
    expect(readFileSync(join(backup, id, 'package', 'world.json'))).toEqual(source);
    const reset = openDatabase(path);
    const knownIds = new Set(reset.prepare('SELECT id FROM worlds').all().map(row => String(row.id)));
    reset.close();
    expect(await files.cleanupOrphans(knownIds)).toBe(1);
    expect(existsSync(join(dir, 'workspaces', 'worlds', id))).toBe(false);
    expect(readFileSync(join(backup, id, 'source', 'world.json'))).toEqual(source);
    expect(readFileSync(join(backup, id, 'package', 'assets', 'image.bin'))).toEqual(asset);
  });

  it.each(['root', 'nested-file'] as const)('rejects a %s source symlink without clearing the database', async kind => {
    const { dir, path } = seedRetired(), before = snapshot(path), outside = temporaryDirectory();
    const sentinel = join(outside, 'external.txt');
    writeFileSync(sentinel, 'external files stay untouched');
    mkdirSync(join(dir, 'workspaces'));
    if (kind === 'root') symlinkSync(outside, join(dir, 'workspaces', 'worlds'), 'dir');
    else {
      const root = join(dir, 'workspaces', 'worlds');
      mkdirSync(root);
      writeFileSync(join(root, 'regular.txt'), 'safe file');
      symlinkSync(sentinel, join(root, 'linked.txt'), 'file');
    }
    await expect(resetRuntimeData(dir, true)).rejects.toMatchObject({
      message: 'World files backup failed; database left unchanged',
      cause: { message: kind === 'root' ? 'World file root must be a real directory' : 'World file backup accepts only regular files and directories' },
    });
    expect(snapshot(path)).toEqual(before);
    expect(readFileSync(sentinel, 'utf8')).toBe('external files stay untouched');
    expect(readdirSync(dir).filter(name => name.endsWith('.world-files'))).toEqual([]);
  });

  it.each([0, 5, 7, 8])('refuses reset of unsupported v%i before backup or writes', async version => {
    const { dir, path } = seedRetired(), db = new DatabaseSync(path);
    db.exec('PRAGMA user_version='+version); db.close();
    const before = snapshot(path);
    await expect(resetRuntimeData(dir, true)).rejects.toThrow('Expected retired schema v6');
    expect(snapshot(path)).toEqual(before);
    expect(readdirSync(dir).some(name => name.startsWith('before-runtime-'))).toBe(false);
  });

  it('requires confirmation and does not create a missing database', async () => {
    const { dir, path } = seedRetired(), before = snapshot(path);
    await expect(resetRuntimeData(dir, false)).rejects.toThrow('--confirm-reset-runtime');
    expect(snapshot(path)).toEqual(before);
    const empty = temporaryDirectory();
    await expect(resetRuntimeData(empty, true)).rejects.toThrow();
    expect(existsSync(join(empty, 'sillyrealms.sqlite'))).toBe(false);
  });

  it('rolls back the data and version if final settings publication fails, retaining the backup', async () => {
    const { dir, path } = seedRetired(), db = new DatabaseSync(path);
    db.exec("CREATE TRIGGER reject_reset AFTER UPDATE OF default_preset_id ON app_settings WHEN NEW.default_preset_id='sr-default-preset' BEGIN SELECT RAISE(ABORT,'reset blocked'); END;");
    db.close();
    const before = snapshot(path);
    await expect(resetRuntimeData(dir, true)).rejects.toThrow('reset blocked');
    expect(snapshot(path)).toEqual(before);
    const backups = readdirSync(dir).filter(name => name.startsWith('before-runtime-v7-'));
    expect(backups).toHaveLength(1);
    expect(snapshot(join(dir, backups[0]!))).toEqual(before);
  });

  it('honors the server directory lock before backup or writes', async () => {
    const { dir, path } = seedRetired(), before = snapshot(path);
    const release = await lockfile.lock(dir, { stale: 10000, update: 2000, retries: 0 });
    try {
      await expect(resetRuntimeData(dir, true)).rejects.toMatchObject({ code: 'ELOCKED' });
      expect(snapshot(path)).toEqual(before);
      expect(readdirSync(dir).some(name => name.startsWith('before-runtime-'))).toBe(false);
    } finally { await release(); }
  });

  it('runs the CLI only with explicit confirmation against the isolated data directory', () => {
    const { dir, path } = seedRetired(), before = snapshot(path);
    const script = fileURLToPath(new URL('../../../scripts/reset-runtime-data.ts', import.meta.url));
    const options = {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      env: { ...process.env, SILLYREALMS_DATA_DIR: dir },
      encoding: 'utf8' as const, timeout: 15000,
    };
    const rejected = spawnSync(process.execPath, ['--import', 'tsx', script], options);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('--confirm-reset-runtime');
    expect(snapshot(path)).toEqual(before);
    const accepted = spawnSync(process.execPath, ['--import', 'tsx', script, '--confirm-reset-runtime'], options);
    expect(accepted.status, accepted.stderr).toBe(0);
    const result = JSON.parse(accepted.stdout);
    expect(result.schema).toBe(7);
    expect(existsSync(result.backup)).toBe(true);
    expect(snapshot(path).rows.worlds).toEqual([]);
  }, 20000);
});
