import {expect,it} from 'vitest';
import type {Api,AssistantMessageEvent,Model} from '@earendil-works/pi-ai';
import type {ModelGateway} from '../src/agent/model/pi-gateway.js';
import type {CredentialStore} from '../src/infrastructure/credentials/store.js';
import {openDatabase} from '../src/infrastructure/database/database.js';
import {createApp} from '../src/app.js';

it('runs V1 state, message and events through a temporary database and fake provider',async()=>{
  const db=openDatabase(':memory:');
  const model:Model<Api>={id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://localhost',input:['text'],reasoning:false,contextWindow:32768,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  const credentials:CredentialStore={get:async()=> 'fake',set:async()=>{},delete:async()=>{}};
  let calls=0;
  const result=(content:unknown[],stopReason:'stop'|'toolUse')=>({role:'assistant' as const,content,api:'openai-completions',provider:'fake',model:'fake',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason,timestamp:0});
  const gateway:ModelGateway={resolve:()=>model,toolVerified:()=>true,stream:()=>({async *[Symbol.asyncIterator](){calls++;if(calls===1)yield {type:'done',reason:'toolUse',message:result([{type:'toolCall',id:'x',name:'update_state',arguments:{path:'进度.阶段',value:'导入'}}],'toolUse')} as AssistantMessageEvent;else {yield {type:'text_delta',contentIndex:0,delta:'故事开始',partial:{} as never} as AssistantMessageEvent;yield {type:'done',reason:'stop',message:result([{type:'text',text:'故事开始'}],'stop')} as AssistantMessageEvent;}}})};
  const app=createApp(db,credentials,gateway);
  const post=(value:unknown)=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
  try {
    const card={spec:'world_card',spec_version:'0.1',data:{name:'测试',characters:[{id:'p',name:'玩家',player_selectable:true}],openings:[{id:'o',name:'开局',content:'你好'}],state:{schema_version:1,scopes:{message:{进度:{type:'json',initial:{阶段:'日常'},description:'当前阶段'}}}}}};
    const form=new FormData();form.set('file',new File([JSON.stringify(card)],'test.json'));
    const imported=await (await app.request('/api/v1/worlds/import',{method:'POST',body:form})).json() as {data:{item:{id:string}}};
    const worldId=imported.data.item.id;
    const ids=['main','personaInfo','characterInfo','worldState','chatHistory','userInput','postHistory'];
    const preset={name:'test',budget:{max_output_tokens:64},summary_prompt:'summary',nodes:ids.map(id=>({id,name:id,kind:'system',source:id,role:id==='chatHistory'?'auto':id==='userInput'?'user':'system',enabled:true}))};
    db.prepare('INSERT INTO api_model_configs VALUES(?,?,?,?,?,?,?)').run('m','test','fake','fake','ref',1,1);
    db.prepare('INSERT INTO presets(id,name,config_json,created_at,updated_at) VALUES(?,?,?,?,?)').run('preset','test',JSON.stringify(preset),1,1);
    db.prepare("UPDATE worlds SET default_preset_id=?,default_api_model_config_id='m' WHERE id=?").run('preset',worldId);
    const created=await (await app.request('/api/v1/sessions',post({worldId,openingId:'o',userCharacterId:'p'}))).json() as {data:{item:{id:string;tipEntryId:string}}};
    const session=created.data.item;
    const events=await app.request(`/api/v1/sessions/${session.id}/events`);const reader=events.body!.getReader();
    const sent=await app.request(`/api/v1/sessions/${session.id}/runs`,post({text:'继续',requestId:'123e4567-e89b-42d3-a456-426614174000',expectedTipEntryId:session.tipEntryId}));
    expect(sent.status).toBe(202);expect((await sent.json() as {code:string}).code).toBe('OK');
    let text='';while(!text.includes('event: run.completed')){const part=await reader.read();if(part.done)break;text+=new TextDecoder().decode(part.value);}
    expect(text).toContain('event: run.created');expect(text).toContain('event: run.delta');expect(text).toContain('event: state.changed');
    const state=await (await app.request(`/api/v1/sessions/${session.id}/state`)).json() as {data:{message:{进度:{阶段:string}}}};
    expect(state.data.message.进度.阶段).toBe('导入');
    const history=await (await app.request(`/api/v1/sessions/${session.id}/runs`)).json() as {data:{runs:Array<{messages:Array<{text:string}>}>}};
    expect(history.data.runs.flatMap(run=>run.messages.map(message=>message.text))).toContain('故事开始');
    await reader.cancel();
  } finally {db.close();}
});
