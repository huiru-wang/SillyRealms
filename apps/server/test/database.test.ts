import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/infrastructure/database/database.js';

describe('database initialization', () => {
  it('creates eight tables with restrictive foreign keys and can be repeated', () => {
    const db = openDatabase(':memory:');
    const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    expect(rows).toHaveLength(8);
    expect(rows.some(row=>String(row.sql).includes('REFERENCES presets'))).toBe(true);
    expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(0);
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
    expect(preset.nodes.find((node:{id:string})=>node.id==='main').content).toContain('状态一致性');
    expect(preset.nodes.find((node:{id:string})=>node.id==='postHistory').content).toContain('update_state');

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

it('upgrades only an untouched empty built-in preset and preserves customized content',async()=>{
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
    expect(upgraded.nodes.find((n:{id:string})=>n.id==='main').content).toContain('状态一致性');
    upgraded.nodes.find((n:{id:string})=>n.id==='main').content='CUSTOM_MAIN';
    second.prepare("UPDATE presets SET config_json=? WHERE id='sr-default-preset'").run(JSON.stringify(upgraded));
    second.close();
    const third=openDatabase(path);
    expect(read(third).nodes.find((n:{id:string})=>n.id==='main').content).toBe('CUSTOM_MAIN');
    third.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
