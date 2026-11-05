import { DatabaseSync } from 'node:sqlite';
import { builtinPreset } from '../../domain/preset-default.js';

/** The schema is initialized directly; existing databases are not migrated. */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  const newPresets = !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='presets'").get();
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS worlds (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, data_json TEXT NOT NULL CHECK(json_valid(data_json)),
      state TEXT NOT NULL CHECK(json_valid(state) AND json_type(state) = 'object'),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, UNIQUE(type, name)
    );
    CREATE TABLE IF NOT EXISTS api_model_configs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
      credential_ref TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS presets (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, config_json TEXT NOT NULL CHECK(json_valid(config_json)),
      is_builtin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, world_id TEXT NOT NULL, preset_id TEXT, user_character_id TEXT NOT NULL,
      tip_entry_id TEXT, title TEXT, state TEXT NOT NULL CHECK(json_valid(state) AND json_type(state) = 'object'),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, parent_id TEXT, run_id TEXT NOT NULL,
      seq INTEGER NOT NULL, type TEXT NOT NULL CHECK(type IN ('message','compaction','branch_summary')),
      role TEXT, branch_count INTEGER NOT NULL DEFAULT 0 CHECK(branch_count >= 0), timestamp INTEGER NOT NULL,
      payload TEXT NOT NULL CHECK(json_valid(payload) AND json_type(payload) = 'object'),
      state TEXT CHECK(state IS NULL OR (json_valid(state) AND json_type(state) = 'array')),
      ext_data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(ext_data) AND json_type(ext_data) = 'object'),
      UNIQUE(session_id, seq),
      CHECK((type = 'message' AND role IN ('user','assistant','toolResult') AND role IS NOT NULL)
        OR (type != 'message' AND role IS NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_entries_parent ON entries(session_id, parent_id);
    CREATE INDEX IF NOT EXISTS idx_entries_run ON entries(session_id, run_id, seq);
    CREATE INDEX IF NOT EXISTS idx_entries_role ON entries(session_id, role, seq);
    CREATE INDEX IF NOT EXISTS idx_tags_type_sort ON tags(type, sort_order, name);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at, id);
  `);
  if (newPresets) { const now=Date.now(); db.prepare('INSERT INTO presets(id,name,config_json,is_builtin,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('builtin/default',builtinPreset.name,JSON.stringify(builtinPreset),1,now,now); }
  return db;
}

/** Runs that were in flight at process death cannot resume their in-memory workspaces. */
export function recoverInterrupted(db: DatabaseSync): void {
  db.exec(`
    UPDATE entries SET ext_data = json_set(ext_data, '$.run.status', 'interrupted')
      WHERE role = 'user' AND json_extract(ext_data, '$.run.status') = 'running';
    UPDATE entries SET ext_data = json_set(ext_data, '$.status', 'interrupted')
      WHERE json_extract(ext_data, '$.origin') = 'stream_partial' AND json_extract(ext_data, '$.status') = 'streaming';
  `);
}
