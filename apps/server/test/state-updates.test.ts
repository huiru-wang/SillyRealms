import { expect, it } from 'vitest';
import { openDatabase } from '../src/infrastructure/database/database.js';
import { stateUpdateRoutes } from '../src/routes/state-updates.js';
import type { AgentRuntime } from '../src/agent/runtime/agent-runtime.js';

it('commits state items independently, returns every result and emits committed changes only',async()=>{
  const db=openDatabase(':memory:');
  try {
    const card={spec:'world_card',spec_version:'0.1',data:{name:'test',characters:[{id:'p',name:'玩家',player_selectable:true}],openings:[{id:'o',name:'开局',content:'开始'}],state:{schema_version:1,scopes:{message:{灵力:{type:'number',initial:5,min:0,max:10},进度:{type:'json',initial:{阶段:'日常'}}}}}}};
    db.prepare('INSERT INTO worlds(id,name,data_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('w','test',JSON.stringify(card),'{}',1,1);
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?)').run('s','w',null,'p','e',null,'{}',1,1);
    db.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,branch_count,timestamp,payload,state,ext_data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('e','s',null,'r',1,'message','assistant',0,1,JSON.stringify({message:{role:'assistant',content:'开始'}}),JSON.stringify([{key:'灵力',value:5},{key:'进度',value:{阶段:'日常'}}]),'{}');
    const events:Array<{event:string;payload:unknown}>=[];
    const runtime={worldBusy:()=>false,emit:(_id:string,event:string,payload:unknown)=>events.push({event,payload})} as unknown as AgentRuntime;
    const app=stateUpdateRoutes(db,runtime);
    const response=await app.request('/s/state',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({updates:[{path:'灵力',value:1.5},{path:'不存在',value:1},{path:'进度.阶段',value:'导入'},{path:'灵力',value:1.5}]})});
    const result=await response.json() as {data:Array<{success:boolean;message:string}>};
    expect(result.data.map(item=>item.success)).toEqual([true,false,true,true]);expect(result.data[1]?.message).toBe('STATE_NOT_FOUND');
    expect(events).toEqual([{event:'state.changed',payload:{path:'灵力',scope:'message',value:1.5}},{event:'state.changed',payload:{path:'进度.阶段',scope:'message',value:'导入'}}]);
    expect(JSON.parse(String(db.prepare('SELECT state FROM entries WHERE id=?').get('e')?.state))).toEqual([{key:'灵力',value:1.5},{key:'进度',value:{阶段:'导入'}}]);
  } finally {db.close();}
});
