import { DatabaseSync } from 'node:sqlite';
import { normalizeCapabilities } from '../../runtime/config.js';
import { UsageStore } from '../../runtime/persistence/usage-store.js';


/** Additive schema migration. Service startup holds the data-directory lock. */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  const existed = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='worlds'").get();
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  if (version > 2 || (existed && version < 1)) {
    db.close();
    throw new Error(version > 2 ? 'DATABASE_VERSION_UNSUPPORTED' : 'OLD_DATABASE_UNSUPPORTED: 旧数据库需要独立迁移，未改动任何数据');
  }
  if (existed && version === 2) {
    const columns = db.prepare("SELECT name FROM pragma_table_info('sessions')").all().map(row => row.name);
    if (!['execution_mode', 'capability_overrides_json', 'capability_revision'].every(name => columns.includes(name))) {
      db.close(); throw new Error('DATABASE_SCHEMA_VERSION_MISMATCH');
    }
  }
  // SQLite snapshots committed WAL pages before any upgrade.
  if (existed && version === 1 && path !== ':memory:') {
    try { db.prepare('VACUUM INTO ?').run(path + '.backup-v1-' + Date.now()); }
    catch (error) { db.close(); throw error; }
  }
  if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='worlds'").get() &&
      !db.prepare("SELECT name FROM pragma_table_info('worlds') WHERE name='characters_json'").get()) {
    db.close();
    throw new Error('OLD_DATABASE_UNSUPPORTED: 请先停服并显式重建旧 SR 数据库');
  }
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
  try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worlds (
      id TEXT PRIMARY KEY,
      spec TEXT NOT NULL CHECK(spec='world_card'),
      spec_version TEXT NOT NULL CHECK(spec_version='0.1'),
      name TEXT NOT NULL,
      summary TEXT, description TEXT, cover TEXT,
      characters_json TEXT NOT NULL CHECK(json_valid(characters_json) AND json_type(characters_json)='array'),
      openings_json TEXT NOT NULL CHECK(json_valid(openings_json) AND json_type(openings_json)='array'),
      lorebook_json TEXT CHECK(lorebook_json IS NULL OR json_valid(lorebook_json)),
      state_definition_json TEXT CHECK(state_definition_json IS NULL OR json_valid(state_definition_json)),
      message_render_json TEXT CHECK(message_render_json IS NULL OR json_valid(message_render_json)),
      ui_json TEXT CHECK(ui_json IS NULL OR json_valid(ui_json)),
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
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, config_json TEXT NOT NULL CHECK(json_valid(config_json)),
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
      execution_mode TEXT NOT NULL DEFAULT 'direct' CHECK(execution_mode IN ('direct','agent')),
      capability_overrides_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(capability_overrides_json) AND json_type(capability_overrides_json)='object'),
      capability_revision INTEGER NOT NULL DEFAULT 0 CHECK(capability_revision>=0),
      tip_entry_id TEXT, title TEXT, state TEXT NOT NULL CHECK(json_valid(state) AND json_type(state) = 'object'),
      usage_json TEXT NOT NULL DEFAULT '{"cumulative":{"inputTokens":0,"outputTokens":0,"totalTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"reportedCount":0,"unknownCount":0},"latestContext":null,"pendingRun":null}'
        CHECK(json_valid(usage_json) AND json_type(usage_json)='object'),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, parent_id TEXT, run_id TEXT NOT NULL,
      seq INTEGER NOT NULL, type TEXT NOT NULL CHECK(type IN ('message','compaction','branch_summary')),
      role TEXT, branch_count INTEGER NOT NULL DEFAULT 0 CHECK(branch_count >= 0), timestamp INTEGER NOT NULL,
      payload TEXT NOT NULL CHECK(json_valid(payload) AND json_type(payload) = 'object'),
      state TEXT CHECK(state IS NULL OR (json_valid(state) AND json_type(state) = 'array')),
      ext_data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(ext_data) AND json_type(ext_data) = 'object'),
      metrics_json TEXT CHECK(metrics_json IS NULL OR (json_valid(metrics_json) AND json_type(metrics_json)='object')),
      created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec')*1000 AS INTEGER)),
      updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec')*1000 AS INTEGER)),
      UNIQUE(session_id, seq),
      CHECK((type = 'message' AND role IN ('user','assistant','toolResult') AND role IS NOT NULL)
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
  // Additive, idempotent migration for existing local databases. Preserve user rows.
  // Each ALTER is guarded by the actual column list; never reset data to upgrade metrics.
    if (!db.prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name='usage_json'").get()) {
      db.exec(`ALTER TABLE sessions ADD COLUMN usage_json TEXT NOT NULL DEFAULT
        '{"cumulative":{"inputTokens":0,"outputTokens":0,"totalTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"reportedCount":0,"unknownCount":0},"latestContext":null,"pendingRun":null}'
        CHECK(json_valid(usage_json) AND json_type(usage_json)='object')`);
      // No reliable request-level records exist for old runs; do not call
      // historical zeros a complete lifetime total.
      db.exec(`UPDATE sessions SET usage_json=json_set(usage_json,'$.historicalUsageUnknown',json('true'))
        WHERE EXISTS (SELECT 1 FROM entries WHERE entries.session_id=sessions.id
          AND (entries.role='user' OR entries.type='compaction'))`);
    }
    if (!db.prepare("SELECT 1 FROM pragma_table_info('entries') WHERE name='metrics_json'").get())
      db.exec("ALTER TABLE entries ADD COLUMN metrics_json TEXT CHECK(metrics_json IS NULL OR (json_valid(metrics_json) AND json_type(metrics_json)='object'))");

  const builtinNames:Record<string,string> = {main:'叙事风格',personaInfo:'玩家设定',characterInfo:'角色设定',worldState:'世界状态',chatHistory:'聊天历史',userInput:'玩家输入',postHistory:'历史后置'};
  const defaultNodes = ['main','personaInfo','characterInfo','worldState','chatHistory','userInput','postHistory']
    .map(id=>({id,name:builtinNames[id]!,kind:'system',source:id,role:id==='chatHistory'?'auto':id==='userInput'?'user':'system',enabled:true,
      ...(['main','postHistory'].includes(id)?{content:''}:{})}));
  const defaultPreset = {
    name:'标准叙事', capabilities: normalizeCapabilities(undefined), budget:{context_strategy:'standard',max_output_tokens:2048},
    summary_prompt:'概述故事迄今发生的关键事件、角色、状态和未解决的线索，保持准确简洁。',
    nodes:defaultNodes,
  };
  const now=Date.now();
  db.prepare('INSERT OR IGNORE INTO presets(id,name,config_json,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run('sr-default-preset',defaultPreset.name,JSON.stringify(defaultPreset),now,now);
  // Version 2 is additive. Preserve text, world sources, state and explicit modes.
    if (!db.prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name='execution_mode'").get()) {
      db.exec("ALTER TABLE sessions ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'agent' CHECK(execution_mode IN ('direct','agent'))");
      db.exec("UPDATE sessions SET execution_mode='direct' WHERE EXISTS (SELECT 1 FROM entries WHERE entries.session_id=sessions.id AND (json_extract(ext_data,'$.run.extensions.protocol')='sr_extensions/v1' OR json_extract(ext_data,'$.narrative.protocol')='sr_extensions/v1'))");
    }
    if (!db.prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name='capability_overrides_json'").get())
      db.exec("ALTER TABLE sessions ADD COLUMN capability_overrides_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(capability_overrides_json) AND json_type(capability_overrides_json)='object')");
    if (!db.prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name='capability_revision'").get())
      db.exec("ALTER TABLE sessions ADD COLUMN capability_revision INTEGER NOT NULL DEFAULT 0 CHECK(capability_revision>=0)");
    if (version < 2) {
      for (const row of db.prepare('SELECT id,config_json FROM presets').all()) {
        const config = JSON.parse(String(row.config_json));
        config.capabilities = normalizeCapabilities(config.capabilities);
        db.prepare('UPDATE presets SET config_json=? WHERE id=?').run(JSON.stringify(config), String(row.id));
      }
      db.exec('PRAGMA user_version = 2');
    }
  db.prepare('INSERT OR IGNORE INTO app_settings(id,default_preset_id,default_api_model_config_id,created_at,updated_at) VALUES(1,?,?,?,?)')
    .run('sr-default-preset',null,now,now);
  db.exec('COMMIT');
  return db;
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
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
  db.exec(`
    UPDATE entries SET ext_data = json_set(ext_data,
      '$.run.extensions.stateUpdate.status', CASE
        WHEN json_extract(ext_data,'$.run.extensions.stateUpdate.status')='pending' THEN 'failed'
        ELSE json_extract(ext_data,'$.run.extensions.stateUpdate.status') END,
      '$.run.extensions.actionSuggestions.status', CASE
        WHEN json_extract(ext_data,'$.run.extensions.actionSuggestions.status')='pending' THEN 'blocked'
        ELSE json_extract(ext_data,'$.run.extensions.actionSuggestions.status') END,
      '$.run.phase','finalized','$.runtime.finalized',json('true'))
      WHERE role='user' AND json_extract(ext_data,'$.run.status')='running'
        AND json_extract(ext_data,'$.run.extensions.protocol')='sr_extensions/v1';
    UPDATE entries SET ext_data = json_set(ext_data, '$.run.status', 'interrupted')
      WHERE role = 'user' AND json_extract(ext_data, '$.run.status') = 'running';
    UPDATE entries SET ext_data = json_set(ext_data, '$.status', 'interrupted')
      WHERE json_extract(ext_data, '$.origin') = 'stream_partial' AND json_extract(ext_data, '$.status') = 'streaming';
  `);
}
