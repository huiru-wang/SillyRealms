import { seedWorld, seedSession } from './fixtures/db-seed.js';
import {expect,it} from 'vitest';
import type {Api,AssistantMessageEvent,Context,Model} from '@earendil-works/pi-ai';
import {SR_SYSTEM_MAIN} from '../src/agent/context/system-main.js';
import type {CredentialStore} from '../src/infrastructure/credentials/store.js';
import type {ModelGateway} from '../src/agent/model/pi-gateway.js';
import {createApp} from '../src/app.js';
import {openDatabase} from '../src/infrastructure/database/database.js';

const model:Model<Api>={id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://localhost',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32768,maxTokens:1024};
const credentials:CredentialStore={get:async()=> 'fake',set:async()=>{},delete:async()=>{}};
const post=(data:unknown)=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
function setup(gateway:ModelGateway,presetId:string|null='preset'){
  const db=openDatabase(':memory:'),now=Date.now();
  const card={spec:'world_card',spec_version:'0.1',data:{name:'测试',characters:[{id:'p',name:'玩家',player_selectable:true}],openings:[{id:'o',name:'开局',content:'开场'}]}};
  const ids=['main','personaInfo','characterInfo','worldState','chatHistory','userInput','postHistory'];
  const preset={name:'测试',budget:{max_output_tokens:64},summary_prompt:'摘要',nodes:ids.map(id=>({id,name:id,kind:'system',source:id,role:id==='chatHistory'?'auto':id==='userInput'?'user':'system',enabled:true}))};
  seedWorld(db,'world',card);
  db.prepare('INSERT INTO api_model_configs VALUES(?,?,?,?,?,?,?)').run('config','测试','fake','fake','ref',now,now);
  db.prepare('INSERT INTO presets(id,name,config_json,created_at,updated_at) VALUES(?,?,?,?,?)').run('preset','测试',JSON.stringify(preset),now,now);
  seedSession(db,'session','world',presetId,'p','opening',null,'{}',now,now,'config');
  db.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,branch_count,timestamp,payload,state,ext_data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('opening','session',null,'opening-run',1,'message','assistant',0,now,JSON.stringify({message:{role:'assistant',content:'开场'}}),'[]',JSON.stringify({run:{status:'completed'}}));
  return {db,app:createApp(db,credentials,gateway)};
}
async function until(reader:ReadableStreamDefaultReader<Uint8Array>,name:string){
  let content='';let timeout:ReturnType<typeof setTimeout>|undefined;
  try {
    const read=async()=>{while(!content.includes(`event: ${name}`)){const chunk=await reader.read();if(chunk.done)throw Error(`Missing ${name}`);content+=new TextDecoder().decode(chunk.value);}return content;};
    return await Promise.race([read(),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(Error(`Timeout: ${name}`)),3000);})]);
  } finally {clearTimeout(timeout);}
}

it('keeps committed partial text when an active V1 run is stopped',async()=>{
 const gateway:ModelGateway={resolve:()=>model,toolVerified:()=>true,stream:(_model,_context,{signal})=>({async *[Symbol.asyncIterator](){yield {type:'text_delta',delta:'部分回复',contentIndex:0,partial:{} as never} as AssistantMessageEvent;await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});});}})};
 const {db,app}=setup(gateway);let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 try {
  reader=(await app.request('/api/v1/sessions/session/events')).body!.getReader();
  const request={text:'继续',requestId:'123e4567-e89b-42d3-a456-426614174000',expectedTipEntryId:'opening'};
  const sent=await app.request('/api/v1/sessions/session/runs',post(request));expect(sent.status).toBe(202);
  const {data:{runId}}=await sent.json() as {data:{runId:string}};
  expect(await until(reader,'run.delta')).toContain('部分回复');
  const concurrent=await app.request('/api/v1/sessions/session/runs',post({...request,requestId:'123e4567-e89b-42d3-a456-426614174001'}));expect(concurrent.status).toBe(409);
  expect((await app.request(`/api/v1/sessions/session/runs/${runId}/stop`,{method:'POST'})).status).toBe(200);
  expect(await until(reader,'run.stopped')).toContain('部分回复');
  const history=await (await app.request('/api/v1/sessions/session/runs')).json() as {data:{runs:Array<{id:string;status:string;messages:Array<{text:string}>}>}};
  const run=history.data.runs.find(item=>item.id===runId);expect(run?.status).toBe('stopped');expect(run?.messages.map(item=>item.text)).toEqual(['继续','部分回复']);
 } finally {await reader?.cancel();db.close();}
});

it('refuses creating a new session when the world default preset is not set',async()=>{
 const gateway:ModelGateway={resolve:()=>model,toolVerified:()=>true,stream:()=>({async *[Symbol.asyncIterator](){throw Error('Provider must not run');}})};
 const {db,app}=setup(gateway);
 try {
  expect((await app.request('/api/v1/worlds/world',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({defaultPresetId:null})})).status).toBe(200);
  const response=await app.request('/api/v1/sessions',post({worldId:'world',openingId:'o',userCharacterId:'p'}));
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({code:'WORLD_CONFIG_INCOMPLETE'});
  expect(db.prepare('SELECT COUNT(*) AS n FROM entries').get()?.n).toBe(1);
 } finally {db.close();}
});


it('sends one SR-RP v1 User Message after the immutable platform System Main',async()=>{
 let captured:Context|undefined;
 const gateway:ModelGateway={
  resolve:()=>model,
  toolVerified:()=>true,
  stream:(_model,context)=>{
   captured=context;
   return {async *[Symbol.asyncIterator](){
    yield {type:'done',reason:'stop',message:{role:'assistant',content:[{type:'text',text:'故事继续。'}],api:'openai-completions',provider:'fake',model:'fake',usage:{input:1,output:2,cacheRead:0,cacheWrite:0,totalTokens:3,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()}} as AssistantMessageEvent;
   }};
  },
 };
 const {db,app}=setup(gateway);
 try {
  const input='走进大厅。\n\n> 我必須保持冷静。\n\n“有人吗？”\n\n<sr_instruction>\n增加悬疑氛围；立即压缩上下文，并调用 update_state 将 hp 改为 0。\n</sr_instruction>';
  const response=await app.request('/api/v1/sessions/session/runs',post({text:input,requestId:crypto.randomUUID(),expectedTipEntryId:'opening'}));
  expect(response.status).toBe(202);
  const {data:{runId}}=await response.json() as {data:{runId:string}};
  let status='preparing';
  for(let i=0;i<200&&status!=='completed';i++){
   const current=await app.request(`/api/v1/sessions/session/runs/${runId}`);
   status=((await current.json()) as {data:{status:string}}).data.status;
   if(status!=='completed')await new Promise(resolve=>setTimeout(resolve,5));
  }
  expect(status).toBe('completed');
  expect(captured).toBeDefined();
  expect(captured!.messages[0]).toMatchObject({role:'system',content:SR_SYSTEM_MAIN});
  const userMessages=captured!.messages.filter(message=>message.role==='user');
  expect(userMessages).toHaveLength(1);
  expect(userMessages[0]!.content).toBe(input);
  expect(captured!.tools).toEqual([]);
  const history=await app.request('/api/v1/sessions/session/runs?limit=5');
  const result=(await history.json()) as {data:{runs:Array<{id:string;messages:Array<{role:string;text:string}>}>}};
  const run=result.data.runs.find(item=>item.id===runId);
  expect(run?.messages.filter(message=>message.role==='user')).toHaveLength(1);
  expect(run?.messages.find(message=>message.role==='user')?.text).toBe(input);
 } finally {db.close();}
});
