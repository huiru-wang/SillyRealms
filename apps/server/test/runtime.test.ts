import { expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/infrastructure/database/database.js';
import type { CredentialStore } from '../src/infrastructure/credentials/store.js';
import type { ModelGateway } from '../src/agent/model/pi-gateway.js';
import type { Api, AssistantMessageEvent, Model } from '@earendil-works/pi-ai';

const model:Model<Api> = { id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://localhost',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32768,maxTokens:1024 };
class MemoryCredentials implements CredentialStore { async set(){} async get(){return 'dummy';} async delete(){} }
function setup(gateway:ModelGateway) {
  const db = openDatabase(':memory:'), now = Date.now();
  const world = { spec:'world_card',spec_version:'0.1',data:{name:'test',characters:[{id:'player',name:'player',player_selectable:true,description:'{{user}}'}],openings:[{id:'opening',name:'start',content:'opening'}]} };
  const ids = ['main','personaInfo','characterInfo','worldState','chatHistory','userInput','postHistory'];
  const preset = {name:'test',api_model_config_id:'model-config',budget:{max_output_tokens:64},summary_prompt:'summary',nodes:ids.map(id=>({id,kind:'system',role:id==='chatHistory'?'auto':id==='userInput'?'user':'system',enabled:true,content:id==='main'?'hello':''}))};
  db.prepare('INSERT INTO worlds(id,name,data_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('world','test',JSON.stringify(world),'{}',now,now);
  db.prepare('INSERT INTO api_model_configs VALUES(?,?,?,?,?,?,?)').run('model-config','test','fake','fake','secret-ref',now,now);
  db.prepare('INSERT INTO presets(id,name,config_json,created_at,updated_at) VALUES(?,?,?,?,?)').run('preset','test',JSON.stringify(preset),now,now);
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?)').run('session','world','preset','player','opening-entry',null,'{}',now,now);
  db.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,branch_count,timestamp,payload,state,ext_data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('opening-entry','session',null,'opening-run',1,'message','assistant',0,now,JSON.stringify({message:{role:'assistant',content:[{type:'text',text:'opening'}]}}),'[]',JSON.stringify({run:{status:'completed'}}));
  return {db,app:createApp(db,new MemoryCredentials(),gateway)};
}

it('V1 runs survive an event disconnect and lock all sessions in their world',async()=>{
 let release!:()=>void;let started!:()=>void;const ready=new Promise<void>(r=>{started=r;});const gate=new Promise<void>(r=>{release=r;});
 const gateway:ModelGateway={resolve:()=>model,toolVerified:()=>true,stream:()=>({async *[Symbol.asyncIterator](){yield {type:'text_delta',delta:'one',contentIndex:0,partial:{} as never} as AssistantMessageEvent;started();await gate;yield {type:'text_delta',delta:'two',contentIndex:0,partial:{} as never} as AssistantMessageEvent;yield {type:'done',reason:'stop',message:{role:'assistant',content:[{type:'text',text:'onetwo'}],api:'openai-completions',provider:'fake',model:'fake',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:0}} as AssistantMessageEvent;}})};
 const {db,app}=setup(gateway);const now=Date.now();db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?)').run('other','world','preset','player','other-entry',null,'{}',now,now);db.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,branch_count,timestamp,payload,state,ext_data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('other-entry','other',null,'other-open',1,'message','assistant',0,now,JSON.stringify({message:{role:'assistant',content:'opening'}}),'[]','{}');
 const event=await app.request('/api/v1/sessions/session/events');const reader=event.body!.getReader();
 const send=(sid:string,tip:string)=>app.request('/api/v1/sessions/'+sid+'/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'go',requestId:crypto.randomUUID(),expectedTipEntryId:tip})});
 const run=await send('session','opening-entry');expect(run.status).toBe(202);await ready;expect((await send('other','other-entry')).status).toBe(409);
 const write=await app.request('/api/v1/sessions/other/state',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({updates:[{scope:'message',path:'hero.hp',value:7}]})});expect(write.status).toBe(200);expect(await write.json()).toMatchObject({data:[{success:false,message:'WORLD_BUSY'}]});
 await reader.cancel();release();const runId=(await run.json() as {data:{runId:string}}).data.runId;for(let i=0;i<100;i++){if((await (await app.request(`/api/v1/sessions/session/runs/${runId}`)).json() as {data:{status:string}}).data.status==='completed')break;await new Promise(r=>setTimeout(r,5));}
 const history=await (await app.request('/api/v1/sessions/session/runs?limit=5')).json() as {data:{runs:Array<{messages:Array<{role:string;text:string}>}>}};expect(history.data.runs.at(-1)?.messages.filter(s=>s.role==='assistant').map(s=>s.text).join('')).toBe('onetwo');db.close();
});
