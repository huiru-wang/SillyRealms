import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/infrastructure/database/database.js';
import { seedSession, seedWorld } from './fixtures/db-seed.js';

describe('database initialization', () => {
  it('creates nine tables with restrictive foreign keys and can be repeated', () => {
    const db = openDatabase(':memory:');
    const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    expect(rows).toHaveLength(9);
    expect(rows.some(row=>String(row.sql).includes('REFERENCES presets'))).toBe(true);
    expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(3);
    db.close();
  });
  it('allows only configured LAN origins in addition to local origins', async () => {
    const db = openDatabase(':memory:');
    const app = createApp(db, undefined, undefined, undefined, new Set(['http://192.168.1.8:3000', 'http://192.168.1.8:5173']));
    for (const origin of ['http://192.168.1.8:3000', 'http://192.168.1.8:5173', 'http://localhost:5173'])
      expect((await app.request('/health', { headers: { Origin: origin } })).status).toBe(200);
    for (const origin of ['http://192.168.1.9:3000', 'http://192.168.1.8:8080', 'https://192.168.1.8:3000', 'null'])
      expect((await app.request('/api/v1/worlds', { headers: { Origin: origin } })).status).toBe(403);
    db.close();
  });
  it('exposes health and rejects non-local origins', async () => {
    const db = openDatabase(':memory:');
    const app = createApp(db);
    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/health', { headers: { Origin: 'https://example.com' } })).status).toBe(403);
    db.close();
  });
});

it('preserves v1 presets, sessions, history, worlds and model settings during additive v2 migration', async () => {
  const {mkdtempSync,rmSync}=await import('node:fs');
  const {join}=await import('node:path');
  const {tmpdir}=await import('node:os');
  const dir=mkdtempSync(join(tmpdir(),'sr-preset-migrate-')),path=join(dir,'app.sqlite');
  try {
    const before=openDatabase(path);
    before.prepare('INSERT INTO presets VALUES(?,?,?,?,?)').run('custom','自定义','{"name":"自定义"}',1,1);
    before.prepare('INSERT INTO api_model_configs VALUES(?,?,?,?,?,?,?)').run('model','model','fake','fake','ref',1,1);
    seedWorld(before,'world',undefined,'custom','model');
    seedSession(before,'session','world','custom','player','entry','保留','{}',1,1,'model');
    before.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,branch_count,timestamp,payload,ext_data) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run('entry','session',null,'r',1,'message','assistant',0,1,'{"message":{"role":"assistant","content":"保留故事"}}','{}');
    before.prepare("UPDATE sessions SET usage_json=json_set(usage_json,'$.latestContext',json('{\"inputTokens\":5}')) WHERE id='session'").run();
    before.prepare("UPDATE app_settings SET default_preset_id='custom',default_api_model_config_id='model'").run();
    before.exec('PRAGMA user_version = 1');
    before.close();
    const after=openDatabase(path);
    expect(after.prepare('SELECT id FROM presets ORDER BY id').all()).toEqual([{id:'custom'},{id:'sr-default-preset'}]);
    const preset=JSON.parse(String(after.prepare('SELECT config_json FROM presets WHERE id=\'sr-default-preset\'').get()?.config_json));
    expect(preset.budget).toEqual({strategy:'rolling_summary',max_context_tokens:32768,max_output_tokens:2048});
    expect(after.prepare("SELECT preset_id,title,api_model_config_id FROM sessions WHERE id='session'").get()).toMatchObject({preset_id:'custom',title:'保留',api_model_config_id:'model'});
    expect(JSON.parse(String(after.prepare("SELECT usage_json FROM sessions WHERE id='session'").get()?.usage_json)).latestContext).toEqual({inputTokens:5});
    expect(after.prepare("SELECT payload FROM entries WHERE id='entry'").get()?.payload).toContain('保留故事');
    expect(after.prepare("SELECT default_preset_id,default_api_model_config_id FROM worlds WHERE id='world'").get()).toMatchObject({default_preset_id:'custom',default_api_model_config_id:'model'});
    expect(after.prepare('SELECT default_preset_id,default_api_model_config_id FROM app_settings').get()).toMatchObject({default_preset_id:'custom',default_api_model_config_id:'model'});
    after.prepare('INSERT INTO presets VALUES(?,?,?,?,?)').run('new','新预设','{}',2,2);
    after.close();
    const again=openDatabase(path);
    expect(again.prepare("SELECT id FROM presets WHERE id='new'").get()).toBeDefined();
    again.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

it('marks persisted in-flight data interrupted on startup recovery', async () => {
  const { recoverInterrupted } = await import('../src/infrastructure/database/database.js');
  const db = openDatabase(':memory:');
  const now = Date.now();
  db.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,branch_count,timestamp,payload,state,ext_data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('user','s',null,'r',1,'message','user',0,now,JSON.stringify({message:{role:'user',content:'hi'}}),null,JSON.stringify({run:{status:'running'}}));
  db.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,branch_count,timestamp,payload,state,ext_data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('partial','s','user','r',2,'message','assistant',0,now,JSON.stringify({message:{role:'assistant',content:'half'}}),null,JSON.stringify({origin:'stream_partial',status:'streaming'}));
  recoverInterrupted(db);
  expect(JSON.parse(String(db.prepare('SELECT ext_data FROM entries WHERE id=?').get('user')?.ext_data)).run.status).toBe('interrupted');
  expect(JSON.parse(String(db.prepare('SELECT ext_data FROM entries WHERE id=?').get('partial')?.ext_data)).status).toBe('interrupted');
  expect(JSON.parse(String(db.prepare('SELECT payload FROM entries WHERE id=?').get('partial')?.payload)).message.content).toBe('half');
  db.close();
});

it('seeds the ordinary default preset and retains app defaults across restarts', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir=mkdtempSync(join(tmpdir(),'sr-db-')); const path=join(dir,'test.sqlite');
  try {
    const first=openDatabase(path);
    expect(first.prepare('SELECT id FROM presets').all()).toEqual([{id:'sr-default-preset'}]);
    const preset=JSON.parse(String(first.prepare('SELECT config_json FROM presets WHERE id=?').get('sr-default-preset')?.config_json));
    expect(preset.nodes.find((node:{id:string})=>node.id==='main')).toMatchObject({name:'叙事风格',content:''});
    expect(preset.nodes.find((node:{id:string})=>node.id==='postHistory').content).toBe('');

    expect(first.prepare('SELECT default_preset_id FROM app_settings WHERE id=1').get()?.default_preset_id).toBe('sr-default-preset'); first.close();
    const second=openDatabase(path);
    expect(second.prepare('SELECT id FROM presets WHERE id=?').get('sr-default-preset')).toBeDefined(); second.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

it('does not expose removed world, branch, or event endpoints', async () => {
  const db=openDatabase(':memory:'),app=createApp(db);
  for (const [method,path] of [['POST','/api/v1/worlds'],['PATCH','/api/v1/worlds/example'],['GET','/api/v1/sessions/example/events'],['GET','/api/v1/sessions/example/worldlines'],['POST','/api/v1/sessions/example/regenerate']] as const) {
    expect((await app.request(path,{method})).status).toBe(404);
  }
  db.close();
});

it('does not clean up existing built-in prompt fields during subsequent startup',async()=>{
  const {mkdtempSync,rmSync}=await import('node:fs');
  const {join}=await import('node:path');
  const {tmpdir}=await import('node:os');
  const dir=mkdtempSync(join(tmpdir(),'sr-default-preset-')),path=join(dir,'app.sqlite');
  try {
    const first=openDatabase(path);
    const read=(db:typeof first)=>JSON.parse(String(db.prepare("SELECT config_json FROM presets WHERE id='sr-default-preset'").get()?.config_json));
    const legacy=read(first);
    for(const node of legacy.nodes)delete node.content;
    first.prepare("UPDATE presets SET config_json=? WHERE id='sr-default-preset'").run(JSON.stringify(legacy));
    first.close();
    const second=openDatabase(path);
    const upgraded=read(second);
    expect(upgraded).toEqual(legacy);
    upgraded.nodes.find((n:{id:string})=>n.id==='main').content='CUSTOM_MAIN';
    second.prepare("UPDATE presets SET config_json=? WHERE id='sr-default-preset'").run(JSON.stringify(upgraded));
    second.close();
    const third=openDatabase(path);
    expect(read(third).nodes.find((n:{id:string})=>n.id==='main').content).toBe('CUSTOM_MAIN');
    third.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
