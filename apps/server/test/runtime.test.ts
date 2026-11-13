import { fakeMeasurement } from './fixtures/fake-gateway.js';
import { seedWorld, seedSession } from './fixtures/db-seed.js';
import { expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/infrastructure/database/database.js';
import type { CredentialStore } from '../src/infrastructure/credentials/store.js';
import type { ModelGateway } from '../src/runtime/model/pi-gateway.js';
import type { Api, AssistantMessageEvent, Model } from '@earendil-works/pi-ai';

const model:Model<Api> = { id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://localhost',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32768,maxTokens:1024 };
class MemoryCredentials implements CredentialStore { async set(){} async get(){return 'dummy';} async delete(){} }
function setup(gateway:ModelGateway) {
  const db = openDatabase(':memory:'), now = Date.now();
  const world = { spec:'world_card',spec_version:'0.1',data:{name:'test',characters:[{id:'player',name:'player',player_selectable:true,description:'{{user}}'}],openings:[{id:'opening',name:'start',content:'opening'}]} };
  const ids = ['main','personaInfo','characterInfo','worldState','chatHistory','userInput','postHistory'];
  const preset = {name:'test',budget:{context_strategy:'standard',max_output_tokens:64},summary_prompt:'summary',nodes:ids.map(id=>({id,kind:'system',role:id==='chatHistory'?'auto':id==='userInput'?'user':'system',enabled:true,content:id==='main'?'hello':''}))};
  seedWorld(db,'world',world);
  db.prepare('INSERT INTO api_model_configs VALUES(?,?,?,?,?,?,?)').run('model-config','test','fake','fake','secret-ref',now,now);
  db.prepare('INSERT INTO presets(id,name,config_json,created_at,updated_at) VALUES(?,?,?,?,?)').run('preset','test',JSON.stringify(preset),now,now);
  seedSession(db,'session','world','preset','player','opening-entry',null,'{}',now,now,'model-config');
  db.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,branch_count,timestamp,payload,state,ext_data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('opening-entry','session',null,'opening-run',1,'message','assistant',0,now,JSON.stringify({message:{role:'assistant',content:[{type:'text',text:'opening'}]}}),'[]',JSON.stringify({run:{status:'completed'}}));
  return {db,app:createApp(db,new MemoryCredentials(),gateway)};
}

it('V1 runs survive an event disconnect and lock all sessions in their world',async()=>{
 let release!:()=>void;let started!:()=>void;const ready=new Promise<void>(r=>{started=r;});const gate=new Promise<void>(r=>{release=r;});
 const gateway:ModelGateway={resolve:()=>model,measure:fakeMeasurement,supportsDirect:()=>true,toolVerified:()=>true,stream:()=>({async *[Symbol.asyncIterator](){yield {type:'text_delta',delta:'one',contentIndex:0,partial:{} as never} as AssistantMessageEvent;started();await gate;yield {type:'text_delta',delta:'two',contentIndex:0,partial:{} as never} as AssistantMessageEvent;yield {type:'done',reason:'stop',message:{role:'assistant',content:[{type:'text',text:'onetwo'}],api:'openai-completions',provider:'fake',model:'fake',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:0}} as AssistantMessageEvent;}})};
 const {db,app}=setup(gateway);const now=Date.now();seedSession(db,'other','world','preset','player','other-entry',null,'{}',now,now,'model-config');db.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,branch_count,timestamp,payload,state,ext_data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('other-entry','other',null,'other-open',1,'message','assistant',0,now,JSON.stringify({message:{role:'assistant',content:'opening'}}),'[]','{}');
 const event=await app.request('/api/v1/sessions/session/events');const reader=event.body!.getReader();
 const send=(sid:string,tip:string)=>app.request('/api/v1/sessions/'+sid+'/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'go',requestId:crypto.randomUUID(),expectedTipEntryId:tip})});
 const run=await send('session','opening-entry');expect(run.status).toBe(202);await ready;expect((await send('other','other-entry')).status).toBe(409);
 const write=await app.request('/api/v1/sessions/other/state',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({updates:[{scope:'message',path:'hero.hp',value:7}]})});expect(write.status).toBe(200);expect(await write.json()).toMatchObject({data:[{success:false,errorCode:'WORLD_BUSY',errorMessage:'世界卡正在使用中'}]});
 await reader.cancel();release();const runId=(await run.json() as {data:{runId:string}}).data.runId;for(let i=0;i<100;i++){if((await (await app.request(`/api/v1/sessions/session/runs/${runId}`)).json() as {data:{status:string}}).data.status==='completed')break;await new Promise(r=>setTimeout(r,5));}
 const history=await (await app.request('/api/v1/sessions/session/runs?limit=5')).json() as {data:{runs:Array<{messages:Array<{role:string;text:string}>}>}};expect(history.data.runs.at(-1)?.messages.filter(s=>s.role==='assistant').map(s=>s.text).join('')).toBe('onetwo');db.close();
});

it('stops a Run while a continuation is waiting for the model',async()=>{
  let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
  let calls=0;
  const gateway:ModelGateway={resolve:()=>model,measure:fakeMeasurement,supportsDirect:()=>true,toolVerified:()=>true,stream:(_m,_context,opts)=>({async *[Symbol.asyncIterator](){
    calls++;
    if(calls===1){
      yield {type:'done',reason:'toolUse',message:{role:'assistant',content:[{type:'toolCall',id:'tool',name:'unknown',arguments:{}}],api:'openai-completions',provider:'fake',model:'fake',usage:{input:5,output:1,cacheRead:0,cacheWrite:0,totalTokens:6,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'toolUse',timestamp:Date.now()}} as AssistantMessageEvent;
    }else{
      started();
      await new Promise<void>(resolve=>opts.signal.addEventListener('abort',()=>resolve(),{once:true}));
    }
  }})};
  const {db}=setup(gateway);
  try {
    const {SRRuntime}=await import('../src/runtime/sr-runtime.js');
    const runtime=new SRRuntime(db,new MemoryCredentials(),gateway);
    const {runId,stream}=await runtime.prepare('session','go',crypto.randomUUID(),'opening-entry');
    const reader=stream.getReader();const draining=(async()=>{while(!(await reader.read()).done){/* drain */}})();
    await ready;
    expect((await runtime.stop('session',runId))?.status).toBe('stopped');
    await draining;
    expect(calls).toBe(2);
    expect(runtime.busy('session')).toBe(false);
  } finally {db.close();}
});

it.each([
  { label: 'preserves a known model error', thrown: new Error('CONTEXT_BUDGET_EXCEEDED'), expected: 'CONTEXT_BUDGET_EXCEEDED', message: '上下文超出模型允许范围' },
  { label: 'redacts an unknown provider exception', thrown: new Error('upstream token secret-12345'), expected: 'PROVIDER_ERROR', message: '模型服务调用失败' },
])('$label in SSE and persisted run status', async ({ thrown, expected, message }) => {
  const gateway: ModelGateway = {
    resolve: () => model,
    measure:fakeMeasurement,supportsDirect:()=>true,toolVerified: () => true,
    stream: () => ({ async *[Symbol.asyncIterator]() { throw thrown; } }),
  };
  const { db, app } = setup(gateway);
  const streamResponse = await app.request('/api/v1/sessions/session/events');
  const reader = streamResponse.body!.getReader();
  try {
    const started = await app.request('/api/v1/sessions/session/runs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'go', requestId: crypto.randomUUID(), expectedTipEntryId: 'opening-entry' }),
    });
    expect(started.status).toBe(202);
    const response = await started.json() as { data: { runId: string } };
    let seen = '';
    for (let i=0; i<12 && !seen.includes('event: run.failed'); i++) {
      const next = await reader.read();
      if (next.done) break;
      seen += new TextDecoder().decode(next.value);
    }
    const failed = /event: run.failed\ndata: ([^\n]+)/.exec(seen);
    expect(failed).not.toBeNull();
    const event = JSON.parse(failed![1]!) as Record<string, unknown>;
    expect(event).toMatchObject({ runId: response.data.runId, errorCode: expected, errorMessage: message });
    expect(event).not.toHaveProperty('error');
    expect(seen).not.toContain('secret-12345');
    const statusResponse = await app.request('/api/v1/sessions/session/runs/' + response.data.runId);
    expect(await statusResponse.json()).toMatchObject({
      success: true, data: { status: 'failed', errorCode: expected, errorMessage: message },
    });
  } finally { await reader.cancel(); db.close(); }
});

it('reports asynchronous preflight failures through the same SSE fields', async () => {
  const limited: Model<Api> = { ...model, maxTokens: 32 };
  const gateway: ModelGateway = {
    resolve: () => limited, measure:fakeMeasurement,supportsDirect:()=>true,toolVerified: () => true,
    stream: () => ({ async *[Symbol.asyncIterator]() { throw Error('should not call model'); } }),
  };
  const { db, app } = setup(gateway);
  const events = await app.request('/api/v1/sessions/session/events');
  const reader = events.body!.getReader();
  try {
    const started = await app.request('/api/v1/sessions/session/runs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'go', requestId: crypto.randomUUID(), expectedTipEntryId: 'opening-entry' }),
    });
    expect(started.status).toBe(202);
    let output='';
    for (let i=0; i<12 && !output.includes('event: run.failed'); i++) {
      const next=await reader.read();if(next.done)break;
      output+=new TextDecoder().decode(next.value);
    }
    const failed=/event: run.failed\ndata: ([^\n]+)/.exec(output);
    expect(JSON.parse(failed![1]!)).toMatchObject({
      errorCode:'CONTEXT_BUDGET_EXCEEDED',errorMessage:'上下文超出模型允许范围',
    });
  } finally { await reader.cancel(); db.close(); }
});
