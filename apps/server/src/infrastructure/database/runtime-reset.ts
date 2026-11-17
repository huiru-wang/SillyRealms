import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { cp, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import lockfile from 'proper-lockfile';
import { createSchema, DATABASE_VERSION } from './database.js';

const RETIRED_VERSION = 6;
const runtimeTables = ['tag_assignments', 'tags', 'run_preparations', 'entries', 'sessions', 'worlds', 'presets'] as const;
type RuntimeTable = typeof runtimeTables[number];

function assertRetiredSchema(db: DatabaseSync): void {
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) !== RETIRED_VERSION)
    throw new Error('Expected retired schema v6; database left unchanged');
  const requiredColumns: Record<string, string[]> = {
    api_model_configs: ['id', 'name', 'provider_id', 'model_id', 'credential_ref', 'created_at', 'updated_at'],
    app_settings: ['id', 'default_preset_id', 'default_api_model_config_id', 'created_at', 'updated_at'],
    worlds: ['id', 'components', 'stage_component', 'state_definition_json', 'state'],
    sessions: ['id', 'world_id', 'state'],
    entries: ['id', 'session_id', 'state'],
    presets: ['id', 'model_parameters', 'context_strategy', 'config_json'],
    tags: ['id', 'type'],
    tag_assignments: ['id', 'tag_id', 'target_id'],
    run_preparations: ['run_id', 'session_id'],
  };
  for (const [table, required] of Object.entries(requiredColumns)) {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name)));
    if (required.some(column => !columns.has(column)))
      throw new Error('Expected complete schema v6; database left unchanged');
  }
}

/** Keep sources and extracted packages outside the live tree that startup orphan cleanup can remove. */
async function backupWorldFiles(dir: string, databaseBackup: string): Promise<string | null> {
  const source = join(dir, 'workspaces', 'worlds'), destination = databaseBackup + '.world-files';
  let created = false;
  try {
    for (const current of [join(dir, 'workspaces'), source]) {
      const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stat) return null;
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('World file root must be a real directory');
    }
    await mkdir(destination, { mode: 0o700 });
    created = true;
    for (const name of await readdir(source)) {
      await cp(join(source, name), join(destination, name), {
        recursive: true, force: false, errorOnExist: true, dereference: false, preserveTimestamps: true,
        filter: async path => {
          const stat = await lstat(path);
          if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
            throw new Error('World file backup accepts only regular files and directories');
          return true;
        },
      });
    }
    return destination;
  } catch (error) {
    if (created) await rm(destination, { recursive: true, force: true }).catch(() => {});
    throw new Error('World files backup failed; database left unchanged', { cause: error });
  }
}

/** Explicit destructive reset, not a state or preset migration. Uses the same directory lock as the server. */
export async function resetRuntimeData(directory: string, confirmed: boolean) {
  if (!confirmed)
    throw new Error('Pass --confirm-reset-runtime to delete old worlds, states, presets and sessions');
  const dir = resolve(directory), path = join(dir, 'sillyrealms.sqlite');
  if (!statSync(dir).isDirectory() || !statSync(path).isFile())
    throw new Error('Expected an existing runtime database; no data changed');
  const release = await lockfile.lock(dir, { stale: 10000, update: 2000, retries: 0 });
  try {
    const db = new DatabaseSync(path);
    try {
      assertRetiredSchema(db);
      db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
      const backup = join(dir, `before-runtime-v${DATABASE_VERSION}-${Date.now()}-${randomUUID()}.sqlite`);
      db.prepare('VACUUM INTO ?').run(backup);
      const worldFilesBackup = await backupWorldFiles(dir, backup);
      db.exec('BEGIN IMMEDIATE');
      try {
        assertRetiredSchema(db);
        const removed = Object.fromEntries(runtimeTables.map(table => [
          table, Number(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count),
        ])) as Record<RuntimeTable, number>;
        // All v1 definitions, snapshots and references are discarded. Model rows and credential references survive.
        db.exec('UPDATE app_settings SET default_preset_id=NULL');
        for (const table of runtimeTables) db.exec(`DELETE FROM ${table}`);
        createSchema(db);
        db.prepare("UPDATE app_settings SET default_preset_id='sr-default-preset',updated_at=? WHERE id=1").run(Date.now());
        if (db.prepare('PRAGMA foreign_key_check').all().length)
          throw new Error('Reference validation failed; database left unchanged');
        db.exec('COMMIT');
        return { removed, schema: DATABASE_VERSION, backup, worldFilesBackup };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } finally { db.close(); }
  } finally { await release(); }
}
