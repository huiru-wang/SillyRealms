import { expect,it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase,recoverInterrupted } from '../src/infrastructure/database/database.js';
import { seedSession,seedWorld } from './fixtures/db-seed.js';
import { publicRunResult } from '../src/domain/session/run-result.js';
function legacy(path:string,explicit=false){
  const db=openDatabase(path);seedWorld(db,'w');
  seedSession(db,'s','w','sr-default-preset','p','e','KEEP_TITLE','{}',1,2,'test-model','agent');
  seedSession(db,'d','w','sr-default-preset','p','de','DIRECT','{}',1,2,'test-model','direct');
  db.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,timestamp,payload,state,ext_data) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('e','s',null,'r',1,'message','user',1,'{"message":{"role":"user","content":"<sr_instruction>keep</sr_instruction> 历史"}}','[]','{"run":{"status":"completed"}}');
  db.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,timestamp,payload,state,ext_data) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('de','d',null,'dr',1,'message','user',1,'{"message":{"role":"user","content":"direct history"}}','[]','{"run":{"status":"completed","extensions":{"protocol":"sr_extensions/v1"}}}');
  const preset=JSON.parse(String(db.prepare('SELECT config_json FROM presets').get()!.config_json));
  preset.nodes.push({id:'custom',kind:'text',role:'assistant',enabled:false,content:'KEEP_CUSTOM'});
  preset.nodes.find((n:any)=>n.id==='postHistory').content='KEEP_POST';
  delete preset.capabilities;
  db.prepare('UPDATE presets SET config_json=?').run(JSON.stringify(preset));
  db.prepare('INSERT INTO tags VALUES(?,?,?,?,?,?)').run('tag','world','KEEP_TAG',1,1,1);
  if(!explicit)db.exec('ALTER TABLE sessions DROP COLUMN execution_mode;');
  db.exec('DROP TABLE run_preparations;ALTER TABLE sessions DROP COLUMN capability_overrides_json;ALTER TABLE sessions DROP COLUMN capability_revision;PRAGMA user_version=1;');
  return db;
}
it('backs up v1 before additive mode inference and preserves all source content and references',()=>{
  const folder=mkdtempSync(join(tmpdir(),'sr-runtime-migration-')),path=join(folder,'db.sqlite'),source=join(folder,'world.json');
  writeFileSync(source,'{"original":"保留世界文件"}');
  try {
    const before=legacy(path),preset=String(before.prepare('SELECT config_json FROM presets').get()!.config_json);
    before.prepare('UPDATE worlds SET source_file_path=?,source_kind=? WHERE id=?').run(source,'imported','w');
    const snapshots=Object.fromEntries(['worlds','entries','tags','api_model_configs','app_settings'].map(table=>[table,before.prepare('SELECT * FROM '+table).all()]));
    before.close();const bytes=readFileSync(source);
    const db=openDatabase(path);
    expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(3);
    expect(db.prepare('SELECT id,execution_mode FROM sessions ORDER BY id').all()).toEqual([{id:'d',execution_mode:'direct'},{id:'s',execution_mode:'agent'}]);
    for(const [table,rows] of Object.entries(snapshots))expect(db.prepare('SELECT * FROM '+table).all()).toEqual(rows);
    const afterPreset=JSON.parse(String(db.prepare('SELECT config_json FROM presets').get()!.config_json));delete afterPreset.capabilities;
    expect(afterPreset).toEqual(JSON.parse(preset));
    expect(readFileSync(source)).toEqual(bytes);
    expect(db.prepare('SELECT count(*) AS count FROM sqlite_master WHERE type=?').get('table')!.count).toBe(9);
    db.prepare("UPDATE sessions SET execution_mode='direct',capability_revision=7,capability_overrides_json='{\"state_update\":false}' WHERE id='s'").run();
    db.close();
    const backups=readdirSync(folder).filter(name=>name.includes('.backup-v1-'));expect(backups).toHaveLength(1);
    const backup=new DatabaseSync(join(folder,backups[0]!));expect(backup.prepare('PRAGMA user_version').get()!.user_version).toBe(1);
    expect(backup.prepare('SELECT config_json FROM presets').get()!.config_json).toBe(preset);backup.close();
    const again=openDatabase(path);expect(again.prepare("SELECT execution_mode,capability_revision FROM sessions WHERE id='s'").get()).toMatchObject({execution_mode:'direct',capability_revision:7});again.close();
    expect(readdirSync(folder).filter(name=>name.includes('.backup-v1-'))).toHaveLength(1);
  } finally {rmSync(folder,{recursive:true,force:true});}
});
it('preserves an explicit pre-existing mode instead of overwriting it from history',()=>{
  const folder=mkdtempSync(join(tmpdir(),'sr-explicit-mode-')),path=join(folder,'db.sqlite');
  try {const old=legacy(path,true);old.prepare("UPDATE sessions SET execution_mode='agent' WHERE id='d'").run();old.close();
    const db=openDatabase(path);expect(db.prepare("SELECT execution_mode FROM sessions WHERE id='d'").get()!.execution_mode).toBe('agent');db.close();
  }finally{rmSync(folder,{recursive:true,force:true});}
});
it('rolls back every new column and preset change when v2 migration validation fails',()=>{
  const folder=mkdtempSync(join(tmpdir(),'sr-rollback-')),path=join(folder,'db.sqlite');
  try {
    const before=legacy(path);
    before.exec('ALTER TABLE sessions DROP COLUMN usage_json; ALTER TABLE entries DROP COLUMN metrics_json;');
    before.prepare("UPDATE presets SET config_json=json_set(config_json,'$.capabilities',json('null'))").run();
    const old=String(before.prepare('SELECT config_json FROM presets').get()!.config_json);before.close();
    expect(()=>openDatabase(path)).toThrow();
    const db=new DatabaseSync(path);
    expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(1);
    const columns=db.prepare("SELECT name FROM pragma_table_info('sessions')").all().map(c=>c.name);
    for(const column of ['execution_mode','usage_json','capability_overrides_json','capability_revision'])expect(columns).not.toContain(column);
    expect(db.prepare('SELECT config_json FROM presets').get()!.config_json).toBe(old);
    expect(db.prepare('SELECT count(*) AS count FROM entries').get()!.count).toBe(2);db.close();
  }finally{rmSync(folder,{recursive:true,force:true});}
});
it.each([0,4])('rejects unsupported source schema version %s without rewriting data',version=>{
  const folder=mkdtempSync(join(tmpdir(),'sr-schema-guard-')),path=join(folder,'db.sqlite');
  try{const before=legacy(path);before.exec('PRAGMA user_version='+version);before.close();const bytes=readFileSync(path);
    expect(()=>openDatabase(path)).toThrow();expect(readFileSync(path)).toEqual(bytes);
  }finally{rmSync(folder,{recursive:true,force:true});}
});
it('normalizes interrupted Direct pending extensions without publishing hidden diagnostics',()=>{
  const db=openDatabase(':memory:');
  try{
    db.prepare('INSERT INTO entries(id,session_id,run_id,seq,type,role,timestamp,payload,ext_data) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('u','s','r',1,'message','user',1,'{"message":{"role":"user","content":"go"}}',JSON.stringify({run:{
        status:'running',executionMode:'direct',extensions:{protocol:'sr_extensions/v1',stateUpdate:{status:'pending'},actionSuggestions:{status:'pending'}}},
        runtime:{credential:'NEVER_PUBLIC',reason:'PRIVATE_REASON'}}));
    recoverInterrupted(db);
    const ext=JSON.parse(String(db.prepare('SELECT ext_data FROM entries').get()!.ext_data));
    const result=publicRunResult(ext.run);
    expect(result).toMatchObject({status:'failed',phase:'finalized',errorCode:'RUN_INTERRUPTED',extensions:{stateUpdate:{status:'failed'},actionSuggestions:{status:'blocked'}}});
    expect(JSON.stringify(result)).not.toContain('PRIVATE_REASON');expect(JSON.stringify(result)).not.toContain('NEVER_PUBLIC');
  }finally{db.close();}
});
it('backs up v2 and adds preparation storage without rewriting existing rows',()=>{
  const folder=mkdtempSync(join(tmpdir(),'sr-v3-')),path=join(folder,'db.sqlite');
  try{
    const old=openDatabase(path);seedWorld(old,'w');seedSession(old,'s','w','sr-default-preset','p','e',null,'{}',1,2,'test-model','direct');
    old.exec('DROP TABLE run_preparations;PRAGMA user_version=2;');
    const tables=['worlds','sessions','entries','presets','api_model_configs','app_settings','tags','tag_assignments'];
    const rows=tables.map(table=>old.prepare('SELECT * FROM '+table).all());old.close();
    const upgraded=openDatabase(path);
    tables.forEach((table,i)=>expect(upgraded.prepare('SELECT * FROM '+table).all()).toEqual(rows[i]));
    expect(upgraded.prepare('PRAGMA user_version').get()!.user_version).toBe(3);
    upgraded.prepare('INSERT INTO run_preparations(run_id,session_id,request_id,expected_tip_entry_id,input_text,status,created_at,result_json) VALUES(?,?,?,?,?,?,?,?)')
      .run('run','s','request','e','saved','preparing',1,'{}');
    expect(()=>upgraded.prepare('INSERT INTO run_preparations(run_id,session_id,request_id,expected_tip_entry_id,input_text,status,created_at,result_json) VALUES(?,?,?,?,?,?,?,?)')
      .run('duplicate','s','request','e','saved','preparing',1,'{}')).toThrow();
    upgraded.prepare('DELETE FROM sessions WHERE id=?').run('s');
    expect(upgraded.prepare('SELECT count(*) AS n FROM run_preparations').get()!.n).toBe(0);upgraded.close();
    const backups=readdirSync(folder).filter(name=>name.includes('.backup-v2-'));expect(backups).toHaveLength(1);
    const backup=new DatabaseSync(join(folder,backups[0]!));
    expect(backup.prepare('PRAGMA user_version').get()!.user_version).toBe(2);
    expect(backup.prepare("SELECT name FROM sqlite_master WHERE name='run_preparations'").get()).toBeUndefined();backup.close();
  }finally{rmSync(folder,{recursive:true,force:true});}
});
it('rejects an incomplete v3 preparation table without changing schema',()=>{
  const folder=mkdtempSync(join(tmpdir(),'sr-v3-invalid-')),path=join(folder,'db.sqlite');
  try{
    const old=openDatabase(path);old.exec('ALTER TABLE run_preparations DROP COLUMN metrics_json;');old.close();
    expect(()=>openDatabase(path)).toThrow('DATABASE_SCHEMA_VERSION_MISMATCH');
    const db=new DatabaseSync(path);expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(3);
    expect(db.prepare("SELECT name FROM pragma_table_info('run_preparations') WHERE name='metrics_json'").get()).toBeUndefined();db.close();
  }finally{rmSync(folder,{recursive:true,force:true});}
});
