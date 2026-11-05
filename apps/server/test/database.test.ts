import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/infrastructure/database/database.js';

describe('database initialization', () => {
  it('creates six tables without foreign keys and can be repeated', () => {
    const db = openDatabase(':memory:');
    const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    expect(rows).toHaveLength(6);
    for (const row of rows) expect(String(row.sql)).not.toMatch(/REFERENCES|FOREIGN\s+KEY/i);
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(0);
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
  db.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('user','s',null,'r',1,'message','user',0,now,JSON.stringify({message:{role:'user',content:'hi'}}),null,JSON.stringify({run:{status:'running'}}));
  db.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('partial','s','user','r',2,'message','assistant',0,now,JSON.stringify({message:{role:'assistant',content:'half'}}),null,JSON.stringify({origin:'stream_partial',status:'streaming'}));
  recoverInterrupted(db);
  expect(JSON.parse(String(db.prepare('SELECT ext_data FROM entries WHERE id=?').get('user')?.ext_data)).run.status).toBe('interrupted');
  expect(JSON.parse(String(db.prepare('SELECT ext_data FROM entries WHERE id=?').get('partial')?.ext_data)).status).toBe('interrupted');
  expect(JSON.parse(String(db.prepare('SELECT payload FROM entries WHERE id=?').get('partial')?.payload)).message.content).toBe('half');
  db.close();
});

it('creates the built-in preset only on first initialization and does not restore it after deletion', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir=mkdtempSync(join(tmpdir(),'sr-db-')); const path=join(dir,'test.sqlite');
  try {
    const first=openDatabase(path);
    expect(first.prepare('SELECT is_builtin FROM presets WHERE id=?').get('builtin/default')?.is_builtin).toBe(1);
    first.prepare('DELETE FROM presets WHERE id=?').run('builtin/default'); first.close();
    const second=openDatabase(path);
    expect(second.prepare('SELECT id FROM presets WHERE id=?').get('builtin/default')).toBeUndefined(); second.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

it('does not expose removed world, branch, or event endpoints', async () => {
  const db=openDatabase(':memory:'),app=createApp(db);
  for (const [method,path] of [['POST','/api/v1/worlds'],['PATCH','/api/v1/worlds/example'],['GET','/api/v1/sessions/example/events'],['GET','/api/v1/sessions/example/worldlines'],['POST','/api/v1/sessions/example/regenerate']] as const) {
    expect((await app.request(path,{method})).status).toBe(404);
  }
  db.close();
});
