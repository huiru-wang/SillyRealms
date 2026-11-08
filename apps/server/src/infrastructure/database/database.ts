import { DatabaseSync } from 'node:sqlite';


/** The schema is initialized directly; existing databases are not migrated. */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  const legacy = db.prepare("SELECT name FROM pragma_table_info('presets') WHERE name='is_builtin'").get();
  if (legacy) {
    db.close();
    throw new Error('旧版 SR 数据库：请停服备份并重建数据库');
  }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS worlds (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, preset_id TEXT, warnings_json TEXT NOT NULL DEFAULT '[]', data_json TEXT NOT NULL CHECK(json_valid(data_json)),
      state TEXT NOT NULL CHECK(json_valid(state) AND json_type(state) = 'object'),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('world','preset')), name TEXT NOT NULL CHECK(length(trim(name))>0),
      sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(type, name)
    );
    CREATE TABLE IF NOT EXISTS tag_assignments (
      id TEXT PRIMARY KEY NOT NULL, tag_id TEXT NOT NULL, target_id TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(tag_id,target_id)
    );
    CREATE INDEX IF NOT EXISTS idx_assignment_target ON tag_assignments(target_id,tag_id);
    CREATE TABLE IF NOT EXISTS api_model_configs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
      credential_ref TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS presets (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, config_json TEXT NOT NULL CHECK(json_valid(config_json)),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
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
      created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec')*1000 AS INTEGER)),
      updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec')*1000 AS INTEGER)),
      UNIQUE(session_id, seq),
      CHECK((type = 'message' AND role IN ('user','assistant','toolResult') AND role IS NOT NULL)
        OR (type != 'message' AND role IS NULL))
    );
    CREATE TRIGGER IF NOT EXISTS touch_entry AFTER UPDATE OF payload,ext_data,state,branch_count ON entries
    BEGIN UPDATE entries SET updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id=NEW.id; END;
    CREATE INDEX IF NOT EXISTS idx_world_preset ON worlds(preset_id);
    CREATE INDEX IF NOT EXISTS idx_session_preset ON sessions(preset_id);
    CREATE INDEX IF NOT EXISTS idx_presets_created ON presets(created_at,id);
    CREATE INDEX IF NOT EXISTS idx_worlds_updated ON worlds(updated_at,id);
    CREATE INDEX IF NOT EXISTS idx_entries_parent ON entries(session_id, parent_id);
    CREATE INDEX IF NOT EXISTS idx_entries_run ON entries(session_id, run_id, seq);
    CREATE INDEX IF NOT EXISTS idx_entries_role ON entries(session_id, role, seq);
    CREATE INDEX IF NOT EXISTS idx_tags_type_sort ON tags(type, sort_order, name);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at, id);
    COMMIT;
  `);
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
