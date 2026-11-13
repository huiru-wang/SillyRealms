import { seedSession } from './fixtures/db-seed.js';
import { expect, it } from 'vitest';
import { openDatabase } from '../src/infrastructure/database/database.js';
import { historyRuns } from '../src/domain/session/history-runs.js';

it('pages in ancestry order without splitting runs or exposing tool entries',()=>{
  const db=openDatabase(':memory:');
  try {
    const add=db.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,branch_count,timestamp,payload,state,ext_data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
    const entry=(id:string,parent:string|null,run:string,seq:number,role:string,text:string,extra:object={})=>add.run(id,'s',parent,run,seq,'message',role,0,seq,JSON.stringify({message:{role,content:text}}),null,JSON.stringify(extra));
    entry('a',null,'opening',1,'assistant','开始');
    entry('b','a','r1',2,'user','你好',{run:{status:'completed'}});
    entry('c','b','r1',3,'assistant','回复');
    entry('d','c','r1',4,'toolResult','hidden');
    entry('e','d','r2',5,'user','下一回',{run:{status:'completed'}});
    const newest=historyRuns(db,'s','e',1);
    expect(newest.runs.map(run=>run.id)).toEqual(['r2']);
    const older=historyRuns(db,'s','e',1,newest.nextCursor!);
    expect(older.runs).toEqual([{id:'r1',status:'completed',messages:[{id:'b',role:'user',text:'你好'},{id:'c',role:'assistant',text:'回复'}]}]);
    expect(historyRuns(db,'s','e',20,older.nextCursor!).runs[0]?.id).toBe('opening');
    expect(()=>historyRuns(db,'other','e',1,newest.nextCursor!)).toThrow();
    expect(()=>historyRuns(db,'s','e',21)).toThrow('INVALID_CURSOR');
  } finally { db.close(); }
});

it('serves the target V1 run history inside the common response envelope', async()=>{
  const { createApp } = await import('../src/app.js');
  const db=openDatabase(':memory:');
  try {
    seedSession(db,'s','w',null,'p','e',null,'{}',1,1);
    db.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,branch_count,timestamp,payload,state,ext_data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('e','s',null,'r',1,'message','assistant',0,1,JSON.stringify({message:{role:'assistant',content:'开局'}}),null,'{}');
    const app=createApp(db);
    const response=await app.request('/api/v1/sessions/s/runs?limit=20');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({success:true,errorCode:null,errorMessage:'',data:{runs:[{id:'r',status:'completed',messages:[{id:'e',role:'assistant',text:'开局'}]}],nextCursor:null,hasMore:false}});
    const invalid=await app.request('/api/v1/sessions/s/runs?limit=21');
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({success:false,errorCode:'INVALID_CURSOR',data:null});
  } finally { db.close(); }
});

it('reads only the requested suffix and validates older links when that page is requested', () => {
  const db = openDatabase(':memory:');
  try {
    const add = db.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,payload,ext_data,timestamp) VALUES(?,?,?,?,?,\'message\',\'assistant\',?,\'{}\',1)');
    const insert = (id: string, parent: string | null, run: string, seq: number) =>
      add.run(id, 's', parent, run, seq, JSON.stringify({ message: { content: id } }));
    insert('old', 'missing', 'r0', 1);
    insert('middle', 'old', 'r1', 2);
    insert('latest', 'middle', 'r2', 3);
    const newest = historyRuns(db, 's', 'latest', 1);
    expect(newest.runs.map(run => run.id)).toEqual(['r2']);
    expect(newest.hasMore).toBe(true);
    insert('new-tip', 'latest', 'r3', 4);
    const older = historyRuns(db, 's', 'new-tip', 1, newest.nextCursor!);
    expect(older.runs.map(run => run.id)).toEqual(['r1']);
    expect(() => historyRuns(db, 's', 'new-tip', 1, older.nextCursor!)).toThrow('INVALID_PARENT_CHAIN');
    insert('off-chain', null, 'other', 5);
    const forged = Buffer.from(JSON.stringify({ sessionId: 's', before: 5 })).toString('base64url');
    expect(() => historyRuns(db, 's', 'new-tip', 1, forged)).toThrow('INVALID_CURSOR');
  } finally { db.close(); }
});

it('rejects cursors inside a Run and cyclic page ancestry', () => {
  const db = openDatabase(':memory:');
  try {
    const add = db.prepare("INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,payload,timestamp) VALUES(?,'s',?,'run',?,'message','assistant','{}',1)");
    add.run('a', null, 1); add.run('b', 'a', 2);
    const cursor = Buffer.from(JSON.stringify({ sessionId: 's', before: 2 })).toString('base64url');
    expect(() => historyRuns(db, 's', 'b', 1, cursor)).toThrow('INVALID_CURSOR');
    db.prepare("UPDATE entries SET parent_id='b' WHERE id='a'").run();
    expect(() => historyRuns(db, 's', 'b', 1)).toThrow('INVALID_PARENT_CHAIN');
  } finally { db.close(); }
});
