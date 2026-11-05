import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Api, AssistantMessageEvent, Model } from '@earendil-works/pi-ai';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/infrastructure/database/database.js';
import type { CredentialStore } from '../src/infrastructure/credentials/store.js';
import type { ModelGateway } from '../src/agent/gateway.js';

class MemoryCredentials implements CredentialStore {
  data=new Map<string,string>(); async set(id:string,key:string){this.data.set(id,key);} async get(id:string){return this.data.get(id) ?? null;} async delete(id:string){this.data.delete(id);}
}
const model:Model<Api>={id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://localhost',input:['text'],reasoning:false,contextWindow:32768,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const result=(content:unknown[],stopReason:'stop'|'toolUse')=>({role:'assistant' as const,content,api:'openai-completions',provider:'fake',model:'fake',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason,timestamp:0});
const body=(data:unknown)=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});

it('runs the complete local flow with a fake provider', async () => {
  let calls=0;
  const gateway:ModelGateway={resolve:()=>model,toolVerified:()=>true,stream:(_m,_c,{signal})=>({async *[Symbol.asyncIterator]() {
    calls++;
    if(calls===1) yield {type:'done',reason:'toolUse',message:result([{type:'toolCall',id:'call-1',name:'set_state',arguments:{path:'hero.hp',value:7}}],'toolUse')} as AssistantMessageEvent;
    else if(calls===2) { yield {type:'text_delta',contentIndex:0,delta:'half story',partial:{} as never} as AssistantMessageEvent; await new Promise<void>(resolve=>{if(signal.aborted) resolve(); else signal.addEventListener('abort',()=>resolve(),{once:true});}); }
    else { yield {type:'text_delta',contentIndex:0,delta:'next story',partial:{} as never} as AssistantMessageEvent; yield {type:'done',reason:'stop',message:result([{type:'text',text:'next story'}],'stop')} as AssistantMessageEvent; }
  }})};
  const db=openDatabase(':memory:'), store=new MemoryCredentials(), app=createApp(db,store,gateway);
  const card={spec:'world_card',spec_version:'0.1',data:{name:'test world',tags:['x',' x '],characters:[{id:'player',name:'player',player_selectable:true}],openings:[{id:'opening',name:'start',content:'opening'}],state:{schema_version:1,scopes:{message:{modules:{hero:{type:'object',properties:{hp:{type:'integer',initial:10,min:0,max:20}}}}}}}}};
  const form=new FormData();form.set('file',new File([JSON.stringify(card)],'world.json'));
  const imported=await app.request('/api/v1/worlds/import',{method:'POST',body:form}); expect(imported.status).toBe(201);
  const world=(await imported.json() as {item:{id:string}}).item.id;
  expect(db.prepare('SELECT COUNT(*) AS n FROM tags').get()?.n).toBe(1);
  const providers=await (await app.request('/api/v1/providers/models')).json() as {providers:Array<{providerId:string;models:Array<{id:string}>}>};
  const selected=providers.providers.find(p=>p.models.length)!;
  const configBody={name:'config',providerId:selected.providerId,modelId:selected.models[0]!.id,apiKey:'fake-secret'};
  const c1=await app.request('/api/v1/api-model-configs',body(configBody)); const c2=await app.request('/api/v1/api-model-configs',body({...configBody,apiKey:'different-secret'}));
  expect(c1.status).toBe(201);expect(c2.status).toBe(201);
  const config=(await c1.json() as {item:{id:string}}).item.id;
  const ids=['main','personaInfo','characterInfo','worldState','chatHistory','userInput','postHistory'];
  const p={name:'test',api_model_config_id:config,budget:{max_output_tokens:64},summary_prompt:'summary',nodes:ids.map(id=>({id,name:id,kind:'system',source:id,role:id==='chatHistory'?'auto':id==='userInput'?'user':'system',enabled:true}))};
  const presetResponse=await app.request('/api/v1/presets',body(p)); expect(presetResponse.status).toBe(201); const preset=(await presetResponse.json() as {item:{id:string}}).item.id;
  const sessionResponse=await app.request('/api/v1/sessions',body({worldId:world,openingId:'opening',userCharacterId:'player'}));expect(sessionResponse.status).toBe(201);
  const session=(await sessionResponse.json() as {item:{id:string;tipEntryId:string}}).item;
  const send=(requestId:string,tip:string)=>app.request(`/api/v1/sessions/${session.id}/runs`,body({text:'go',requestId,expectedTipEntryId:tip}));
  const preflight=await send('6ee3a598-05d5-4cb1-8736-b3b0374e6a11',session.tipEntryId); expect(preflight.status).toBe(422);
  const patched=await app.request(`/api/v1/sessions/${session.id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({presetId:preset})});expect(patched.status).toBe(200);
  const run=await send('6ee3a598-05d5-4cb1-8736-b3b0374e6a12',session.tipEntryId);expect(run.status).toBe(200);
  const runId=run.headers.get('x-run-id'),reader=run.body!.getReader();expect(new TextDecoder().decode((await reader.read()).value)).toBe('half story');
  expect((await app.request(`/api/v1/sessions/${session.id}/runs/${runId}/stop`,{method:'POST'})).status).toBe(200);
  const state=await (await app.request(`/api/v1/sessions/${session.id}/state`)).json() as {message:{hero:{hp:number}};tipEntryId:string}; expect(state.message.hero.hp).toBe(7);
  const next=await send('6ee3a598-05d5-4cb1-8736-b3b0374e6a13',state.tipEntryId); expect(await next.text()).toBe('next story');
  const history=await (await app.request(`/api/v1/sessions/${session.id}/history`)).json() as {runs:Array<{entries:Array<{text:string}>}>};
  const visible=history.runs.flatMap(r=>r.entries.map(e=>e.text));expect(visible).toContain('half story');expect(visible).toContain('next story');
  for (let i=0;i<20;i++) {
    const current=await (await app.request(`/api/v1/sessions/${session.id}`)).json() as {item:{tipEntryId:string}};
    const reply=await send(randomUUID(),current.item.tipEntryId); expect(await reply.text()).toBe('next story');
  }
  expect(Number(db.prepare("SELECT COUNT(*) AS n FROM entries WHERE type='compaction'").get()?.n)).toBeGreaterThan(0);
  const finalSession=await (await app.request(`/api/v1/sessions/${session.id}`)).json() as {item:{tipEntryId:string}};
  expect((await app.request(`/api/v1/api-model-configs/${config}`,{method:'DELETE'})).status).toBe(200);
  const missingModel=await send('6ee3a598-05d5-4cb1-8736-b3b0374e6a15',finalSession.item.tipEntryId);
  expect((await missingModel.json() as {error:{code:string}}).error.code).toBe('API_MODEL_CONFIG_NOT_FOUND');
  expect((await app.request(`/api/v1/presets/${preset}`,{method:'DELETE'})).status).toBe(200);
  const missing=await send('6ee3a598-05d5-4cb1-8736-b3b0374e6a14',finalSession.item.tipEntryId);expect((await missing.json() as {error:{code:string}}).error.code).toBe('PRESET_NOT_FOUND');
  expect(JSON.stringify(db.prepare('SELECT * FROM api_model_configs').all())).not.toContain('fake-secret');
  db.close();
});
