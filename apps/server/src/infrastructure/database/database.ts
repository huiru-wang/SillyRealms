import { DatabaseSync } from 'node:sqlite';
import { defaultPreset } from '../../domain/preset/schema.js';
import { insertPreset } from '../../repositories/preset-repository.js';
import { UsageStore } from '../../runtime/persistence/usage-store.js';
export const DATABASE_VERSION=6;
/** Target schema only. Obsolete runtime data is removed by the explicit reset command. */
export function openDatabase(path:string):DatabaseSync {
 const db=new DatabaseSync(path);
 const version=Number(db.prepare('PRAGMA user_version').get()?.user_version??0);
 const existed=!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='worlds'").get();
 if((existed&&version!==DATABASE_VERSION)||version>DATABASE_VERSION){db.close();throw new Error('DATABASE_RESET_REQUIRED');}
 db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
 try {
 createSchema(db);
 db.exec('PRAGMA user_version=6; COMMIT');return db;
 }catch(error){db.exec('ROLLBACK');db.close();throw error;}
}

/** Create and seed the target schema inside the caller's transaction. */
export function createSchema(db:DatabaseSync):void {
 db.exec(`
    CREATE TABLE IF NOT EXISTS worlds (
      id TEXT PRIMARY KEY,
      spec TEXT NOT NULL CHECK(spec='world_card'),
      spec_version TEXT NOT NULL CHECK(spec_version='0.1'),
      name TEXT NOT NULL,
      description TEXT, cover TEXT,
      characters_json TEXT NOT NULL CHECK(json_valid(characters_json) AND json_type(characters_json)='array'),
      openings_json TEXT NOT NULL CHECK(json_valid(openings_json) AND json_type(openings_json)='array'),
      lorebook_json TEXT CHECK(lorebook_json IS NULL OR json_valid(lorebook_json)),
      state_definition_json TEXT CHECK(state_definition_json IS NULL OR json_valid(state_definition_json)),
      message_render_json TEXT CHECK(message_render_json IS NULL OR json_valid(message_render_json)),
      components TEXT CHECK(components IS NULL OR (json_valid(components) AND json_type(components)='array')),
      stage_component TEXT,
      extensions_json TEXT CHECK(extensions_json IS NULL OR json_valid(extensions_json)),
      default_preset_id TEXT REFERENCES presets(id) ON DELETE RESTRICT,
      default_api_model_config_id TEXT REFERENCES api_model_configs(id) ON DELETE RESTRICT,
      state TEXT NOT NULL CHECK(json_valid(state) AND json_type(state)='object'),
      source_file_path TEXT,
      source_sha256 TEXT,
      source_kind TEXT NOT NULL CHECK(source_kind IN ('imported','generated')),
      warnings_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(warnings_json)),
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
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT,
      model_parameters TEXT NOT NULL CHECK(json_valid(model_parameters)),
      context_strategy TEXT NOT NULL CHECK(json_valid(context_strategy)),
      config_json TEXT NOT NULL CHECK(json_valid(config_json)),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY CHECK(id=1),
      default_preset_id TEXT REFERENCES presets(id) ON DELETE RESTRICT,
      default_api_model_config_id TEXT REFERENCES api_model_configs(id) ON DELETE RESTRICT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
      preset_id TEXT NOT NULL REFERENCES presets(id) ON DELETE RESTRICT,
      api_model_config_id TEXT NOT NULL REFERENCES api_model_configs(id) ON DELETE RESTRICT,
      user_character_id TEXT NOT NULL,
      tip_entry_id TEXT, title TEXT, state TEXT NOT NULL CHECK(json_valid(state) AND json_type(state) = 'object'),
      usage_json TEXT NOT NULL DEFAULT '{"cumulative":{"inputTokens":0,"outputTokens":0,"totalTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"reportedCount":0,"unknownCount":0},"latestContext":null,"pendingRun":null}'
        CHECK(json_valid(usage_json) AND json_type(usage_json)='object'),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS run_preparations (
      run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL, expected_tip_entry_id TEXT NOT NULL, input_text TEXT,
      status TEXT NOT NULL CHECK(status IN ('preparing','failed','stopped','interrupted')),
      created_at INTEGER NOT NULL, finished_at INTEGER,
      result_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(result_json)),
      metrics_json TEXT CHECK(metrics_json IS NULL OR json_valid(metrics_json)),
      accounted INTEGER NOT NULL DEFAULT 0 CHECK(accounted IN (0,1)), UNIQUE(session_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, parent_id TEXT, run_id TEXT NOT NULL,
      seq INTEGER NOT NULL, type TEXT NOT NULL CHECK(type IN ('message','compaction')),
      role TEXT, branch_count INTEGER NOT NULL DEFAULT 0 CHECK(branch_count >= 0), timestamp INTEGER NOT NULL,
      payload TEXT NOT NULL CHECK(json_valid(payload) AND json_type(payload) = 'object'),
      state TEXT CHECK(state IS NULL OR (json_valid(state) AND json_type(state) = 'array')),
      ext_data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(ext_data) AND json_type(ext_data) = 'object'),
      metrics_json TEXT CHECK(metrics_json IS NULL OR (json_valid(metrics_json) AND json_type(metrics_json)='object')),
      created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec')*1000 AS INTEGER)),
      updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec')*1000 AS INTEGER)),
      UNIQUE(session_id, seq),
      CHECK((type = 'message' AND role IN ('user','assistant') AND role IS NOT NULL)
        OR (type != 'message' AND role IS NULL))
    );
    CREATE TRIGGER IF NOT EXISTS touch_entry AFTER UPDATE OF payload,ext_data,state,branch_count ON entries
    BEGIN UPDATE entries SET updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id=NEW.id; END;
    CREATE INDEX IF NOT EXISTS idx_world_preset ON worlds(default_preset_id);
    CREATE INDEX IF NOT EXISTS idx_world_model ON worlds(default_api_model_config_id);
    CREATE INDEX IF NOT EXISTS idx_session_preset ON sessions(preset_id);
    CREATE INDEX IF NOT EXISTS idx_session_model ON sessions(api_model_config_id);
    CREATE INDEX IF NOT EXISTS idx_presets_created ON presets(created_at,id);
    CREATE INDEX IF NOT EXISTS idx_worlds_updated ON worlds(updated_at,id);
    CREATE INDEX IF NOT EXISTS idx_entries_parent ON entries(session_id, parent_id);
    CREATE INDEX IF NOT EXISTS idx_entries_run ON entries(session_id, run_id, seq);
    CREATE INDEX IF NOT EXISTS idx_entries_role ON entries(session_id, role, seq);
    CREATE INDEX IF NOT EXISTS idx_tags_type_sort ON tags(type, sort_order, name);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at, id);
 `);
 const now=Date.now();
 if(!db.prepare('SELECT 1 FROM presets').get())insertPreset(db,defaultPreset(),'sr-default-preset');
 const presetId=String(db.prepare('SELECT id FROM presets ORDER BY created_at,id LIMIT 1').get()!.id);
 db.prepare('INSERT OR IGNORE INTO app_settings(id,default_preset_id,default_api_model_config_id,created_at,updated_at) VALUES(1,?,?,?,?)').run(presetId,null,now,now);
 db.exec('PRAGMA user_version=6');
}

/** Runs that were in flight at process death cannot resume their in-memory workspaces. */
export function recoverInterrupted(db: DatabaseSync): void {
  // Replay a stored, unfinished Run using its durable request journal.
  const usage = new UsageStore(db);
  const active = db.prepare("SELECT id,usage_json FROM sessions WHERE json_extract(usage_json,'$.pendingRun.runId') IS NOT NULL").all();
  for (const row of active) {
    const pending = JSON.parse(String(row.usage_json)).pendingRun as {runId:string};
    usage.settleRun(String(row.id), pending.runId, 'interrupted');
  }
  for (const row of db.prepare("SELECT session_id,run_id FROM run_preparations WHERE status='preparing'").all())
    usage.settleRun(String(row.session_id), String(row.run_id), 'interrupted');
  db.exec(`
    UPDATE entries SET ext_data = json_set(ext_data,
      '$.run.extensions.stateUpdate.status', CASE
        WHEN json_extract(ext_data,'$.run.extensions.stateUpdate.status')='pending' THEN 'failed'
        ELSE json_extract(ext_data,'$.run.extensions.stateUpdate.status') END,
      '$.run.extensions.actionSuggestions.status', CASE
        WHEN json_extract(ext_data,'$.run.extensions.actionSuggestions.status')='pending' THEN 'blocked'
        ELSE json_extract(ext_data,'$.run.extensions.actionSuggestions.status') END)
      WHERE role='user' AND json_extract(ext_data,'$.run.status')='running'
        AND json_type(ext_data,'$.run.extensions')='object';
    UPDATE entries SET ext_data = json_set(ext_data, '$.run.status', 'interrupted', '$.run.errorCode', 'RUN_INTERRUPTED')
      WHERE role='user' AND json_extract(ext_data,'$.run.status')='running';
  `);
}
