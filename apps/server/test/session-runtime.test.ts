import { seedSession } from './fixtures/db-seed.js';
import { expect,it } from 'vitest';
import { openDatabase } from '../src/infrastructure/database/database.js';
import { sessionRuntimeRoutes } from '../src/routes/session-runtime.js';
import type { AgentRuntime } from '../src/agent/runtime/agent-runtime.js';

it('forwards Run and state notifications using the target event names',async()=>{
  const db=openDatabase(':memory:');
  try {
    seedSession(db,'s','w',null,'p','e',null,'{}',1,1);
    db.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,branch_count,timestamp,payload,state,ext_data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('e','s',null,'r',1,'message','user',0,1,JSON.stringify({message:{role:'user',content:'你好'}}),null,JSON.stringify({run:{status:'stopped'}}));
    let notify:((target:string,event:string,payload:Record<string,unknown>)=>void)|undefined;
    const runtime={onEvent:(listener:typeof notify)=>{notify=listener;return()=>{notify=undefined;};}} as unknown as AgentRuntime;
    const response=await sessionRuntimeRoutes(db,runtime).request('/s/events');
    const reader=response.body!.getReader();const decoder=new TextDecoder();
    notify!('s','message.created',{runId:'r',message:{id:'e',role:'user',text:'你好'}});
    expect(decoder.decode((await reader.read()).value)).toContain('event: run.created');
    notify!('s','message.delta',{runId:'r',messageId:'a',text:'你好',offset:0});
    expect(decoder.decode((await reader.read()).value)).toContain('event: run.delta');
    notify!('s','state.changed',{path:'灵力',scope:'message',value:5});
    expect(decoder.decode((await reader.read()).value)).toContain('event: state.changed');
    notify!('s','run.updated',{runId:'r',status:'stopped'});
    expect(decoder.decode((await reader.read()).value)).toContain('event: run.stopped');
    await reader.cancel();expect(notify).toBeUndefined();
  } finally {db.close();}
});
