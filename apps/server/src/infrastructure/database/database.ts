import { DatabaseSync } from 'node:sqlite';
import { UsageStore } from '../../agent/persistence/usage-store.js';


/** The schema is initialized directly; existing databases are not migrated. */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='worlds'").get() &&
      !db.prepare("SELECT name FROM pragma_table_info('worlds') WHERE name='characters_json'").get()) {
    db.close();
    throw new Error('OLD_DATABASE_UNSUPPORTED: 请先停服并显式重建旧 SR 数据库');
  }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    BEGIN IMMEDIATE;
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
    COMMIT;
  `);
  // Additive, idempotent migration for existing local databases. Preserve user rows.
  // Each ALTER is guarded by the actual column list; never reset data to upgrade metrics.
  db.exec('BEGIN IMMEDIATE');
  try {
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
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }

  const legacyMain = [
    '你是 SillyRealms 的世界叙事 Agent。根据世界卡、角色、世界书、历史及玩家输入推进故事，保持事实和时间线一致。',
    '尊重玩家对自己角色行动和内心的决定权；不要为了修改状态而虚构剧情事件。',
    '若当前世界存在可写的 message 状态，状态一致性属于本轮任务：叙事中的实际变化必须写入 update_state，不能只在正文中描述。',
    '逐项依照已激活状态的定义、当前值和更新规则判断变化；不得更新 global/session 或未激活状态，不得编造无依据的数值。',
    '工具更新使用目标字段的完整替换值，勿在叙事中输出 JSON Patch 或内部状态检查过程。',
    '没有真实状态变化时不编造更新；工具执行失败应依据结果修正。',
  ].join('\n');
  const legacyPostHistory = [
    '本轮结束前：若存在可写 message 状态，请核对刚刚发生的事件与状态定义。',
    '若确定有变化，调用 update_state 逐项同步；若没有变化，不要制造更新。',
    '所有状态更新以工具为准，正文描述不能代替写入；工具调用后不要继续推进剧情。',
  ].join('\n');
  const builtinNames:Record<string,string> = {main:'叙事风格',personaInfo:'玩家设定',characterInfo:'角色设定',worldState:'世界状态',chatHistory:'聊天历史',userInput:'玩家输入',postHistory:'历史后置'};
  const defaultNodes = ['main','personaInfo','characterInfo','worldState','chatHistory','userInput','postHistory']
    .map(id=>({id,name:builtinNames[id]!,kind:'system',source:id,role:id==='chatHistory'?'auto':id==='userInput'?'user':'system',enabled:true,
      ...(['main','postHistory'].includes(id)?{content:''}:{})}));
  const defaultPreset = {
    name:'标准叙事', budget:{max_output_tokens:2048},
    summary_prompt:'概述故事迄今发生的关键事件、角色、状态和未解决的线索，保持准确简洁。',
    nodes:defaultNodes,
  };
  const now=Date.now();
  db.prepare('INSERT OR IGNORE INTO presets(id,name,config_json,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run('sr-default-preset',defaultPreset.name,JSON.stringify(defaultPreset),now,now);
  // Safely migrate only known previous built-in text. Never overwrite custom prompts.
  const existingDefault = db.prepare("SELECT config_json FROM presets WHERE id='sr-default-preset'").get();
  if (existingDefault) {
    const existing = JSON.parse(String(existingDefault.config_json));
    let changed = false;
    if (Array.isArray(existing.nodes)) for (const node of existing.nodes) {
      if (node.id === 'main') {
        if (node.content === legacyMain || node.content === undefined) { node.content = ''; changed = true; }
      } else if (node.id === 'postHistory') {
        if (node.content === legacyPostHistory || node.content === undefined) { node.content = ''; changed = true; }
      }
      if (builtinNames[node.id] && (node.name === node.id || node.name === '主要提示')) {
        node.name = builtinNames[node.id]; changed = true;
      }
    }
    if (changed) db.prepare("UPDATE presets SET config_json=?,updated_at=? WHERE id='sr-default-preset'")
      .run(JSON.stringify(existing),now);
  }
  db.prepare('INSERT OR IGNORE INTO app_settings(id,default_preset_id,default_api_model_config_id,created_at,updated_at) VALUES(1,?,?,?,?)')
    .run('sr-default-preset',null,now,now);
  return db;
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
    UPDATE entries SET ext_data = json_set(ext_data, '$.run.status', 'interrupted')
      WHERE role = 'user' AND json_extract(ext_data, '$.run.status') = 'running';
    UPDATE entries SET ext_data = json_set(ext_data, '$.status', 'interrupted')
      WHERE json_extract(ext_data, '$.origin') = 'stream_partial' AND json_extract(ext_data, '$.status') = 'streaming';
  `);
}
