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
