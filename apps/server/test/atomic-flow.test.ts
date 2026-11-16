import {tail,response} from './fixtures/runtime-v2.js';
import {defaultPreset} from '../src/domain/preset/schema.js';
import {insertPreset} from '../src/repositories/preset-repository.js';
import {expect,it} from 'vitest';
import type {Api,AssistantMessageEvent,Model} from '@earendil-works/pi-ai';
import type {ModelGateway} from '../src/runtime/model/pi-gateway.js';
import type {CredentialStore} from '../src/infrastructure/credentials/store.js';
import {openDatabase} from '../src/infrastructure/database/database.js';
import {createApp} from '../src/app.js';

it('runs V1 state, message and events through a temporary database and fake provider',async()=>{
  const db=openDatabase(':memory:');
  const model:Model<Api>={id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://localhost',input:['text'],reasoning:false,contextWindow:32768,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  const credentials:CredentialStore={get:async()=> 'fake',set:async()=>{},deleteSync:()=>{}};
  let calls=0;
  const raw='故事开始'+tail([{path:'进度.阶段',value:'导入'},{path:'未知字段',value:1}]);
  const gateway:ModelGateway={resolve:()=>model,supportsDirect:()=>true,stream:()=>({async *[Symbol.asyncIterator](){calls++;yield {type:'text_delta',contentIndex:0,delta:raw,partial:{} as never} as AssistantMessageEvent;yield {type:'done',reason:'stop',message:response(raw)} as AssistantMessageEvent;}})};
  const app=createApp(db,credentials,gateway);
  const post=(value:unknown)=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
  try {
    const card={spec:'world_card',spec_version:'0.1',data:{name:'测试',characters:[{id:'p',name:'玩家',player_selectable:true}],openings:[{id:'o',name:'开局',content:'你好'}],state:{schema_version:1,scopes:{message:{进度:{type:'json',initial:{阶段:'日常'},description:'当前阶段'}}}}}};
    const form=new FormData();form.set('file',new File([JSON.stringify(card)],'test.json'));
    const imported=await (await app.request('/api/v1/worlds/import',{method:'POST',body:form})).json() as {data:{item:{id:string}}};
    const worldId=imported.data.item.id;
    const preset=defaultPreset();preset.name='test';preset.context_strategy={...preset.context_strategy,max_context_tokens:12000,max_output_tokens:64};
    db.prepare('INSERT INTO api_model_configs VALUES(?,?,?,?,?,?,?)').run('m','test','fake','fake','ref',1,1);
    insertPreset(db,preset,'preset');
    db.prepare("UPDATE worlds SET default_preset_id=?,default_api_model_config_id='m' WHERE id=?").run('preset',worldId);
    const created=await (await app.request('/api/v1/sessions',post({worldId,openingId:'o',userCharacterId:'p'}))).json() as {data:{item:{id:string;tipEntryId:string}}};
    const session=created.data.item;
    const events=await app.request(`/api/v1/sessions/${session.id}/events`);const reader=events.body!.getReader();
    const sent=await app.request(`/api/v1/sessions/${session.id}/runs`,post({text:'继续',requestId:'123e4567-e89b-42d3-a456-426614174000',expectedTipEntryId:session.tipEntryId}));
    expect(sent.status).toBe(202);expect((await sent.json() as {success:boolean}).success).toBe(true);
    let text='';while(!text.includes('event: run.completed')&&!text.includes('event: run.failed')){const part=await reader.read();if(part.done)break;text+=new TextDecoder().decode(part.value);}
    expect(text).toContain('event: run.created');expect(text).toContain('event: run.delta');expect(text).toContain('event: state.changed');expect(calls).toBe(1);
    expect(text).toContain('"stateUpdate":{"status":"partial"}');expect(text).not.toContain('STATE_ROOT_NOT_ACTIVE');
    expect(text).not.toContain('event: run.failed');
    const state=await (await app.request(`/api/v1/sessions/${session.id}/state`)).json() as {data:{message:{进度:{阶段:string}}}};
    expect(state.data.message.进度.阶段).toBe('导入');
    const history=await (await app.request(`/api/v1/sessions/${session.id}/runs`)).json() as {data:{runs:Array<{messages:Array<{text:string}>}>}};
    expect(history.data.runs.flatMap(run=>run.messages.map(message=>message.text))).toContain('故事开始');
    await reader.cancel();
  } finally {db.close();}
});
