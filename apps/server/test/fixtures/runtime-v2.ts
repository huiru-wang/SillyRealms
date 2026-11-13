import type { Api, AssistantMessage, AssistantMessageEvent, Model } from '@earendil-works/pi-ai';
import { openDatabase } from '../../src/infrastructure/database/database.js';
import { SRRuntime } from '../../src/runtime/sr-runtime.js';
import type { ModelGateway } from '../../src/runtime/model/pi-gateway.js';
import type { CredentialStore } from '../../src/infrastructure/credentials/store.js';
import { seedWorld, seedSession, fakeCredentials } from './db-seed.js';
export const testModel: Model<Api> = {
  id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://localhost',
  reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32768,maxTokens:4096,
};
export function response(text:string,stopReason:AssistantMessage['stopReason']='stop'):AssistantMessage {
  return {role:'assistant',content:[{type:'text',text}],api:'openai-completions',provider:'fake',model:'fake',
    usage:{input:20,output:10,cacheRead:0,cacheWrite:0,totalTokens:30,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
    stopReason,timestamp:1};
}
export function textGateway(text:string,opts:{chunks?:string[];reason?:AssistantMessage['stopReason'];finalOnly?:boolean}={}):ModelGateway {
  return {resolve:()=>testModel,supportsDirect:()=>true,toolVerified:()=>true,
    stream:()=>({async *[Symbol.asyncIterator](){
      if(!opts.finalOnly)for(const delta of opts.chunks??[text])yield {type:'text_delta',delta,contentIndex:0,partial:{} as never} as AssistantMessageEvent;
      const message=response(text,opts.reason);
      yield {type:'done',reason:message.stopReason,message} as AssistantMessageEvent;
    }})};
}
export function runtimeFixture(gateway:ModelGateway,mode:'direct'|'agent'='direct',credentials:CredentialStore=fakeCredentials){
  const db=openDatabase(':memory:');
  seedWorld(db,'world',{spec:'world_card',spec_version:'0.1',data:{
    name:'Test',characters:[{id:'p',name:'Player',player_selectable:true}],
    openings:[{id:'o',name:'Start',content:'opening'}],
    state:{schema_version:1,scopes:{message:{score:{type:'number',initial:0,min:0}}}},
  }});
  const preset=JSON.parse(String(db.prepare('SELECT config_json FROM presets WHERE id=?').get('sr-default-preset')!.config_json));
  preset.capabilities={state_update:{enabled:true,prompt:''},action_suggestions:{enabled:true,count:3,prompt:''}};
  preset.budget={strategy:'rolling_summary',max_context_tokens:Math.min(16000,Math.floor(gateway.resolve('fake','fake')!.contextWindow*.8)),max_output_tokens:128};
  db.prepare('UPDATE presets SET config_json=? WHERE id=?').run(JSON.stringify(preset),'sr-default-preset');
  seedSession(db,'session','world','sr-default-preset','p','opening',null,'{}',1,1,'test-model',mode);
  db.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,branch_count,timestamp,payload,state,ext_data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('opening','session',null,'opening-run',1,'message','assistant',0,1,JSON.stringify({message:{role:'assistant',content:'opening'}}),'[{"key":"score","value":0}]','{"run":{"status":"completed"}}');
  const runtime=new SRRuntime(db,credentials,gateway);
  return {db,runtime,preset};
}
export async function drain(stream:ReadableStream<Uint8Array>){
  const reader=stream.getReader(),decoder=new TextDecoder();let text='';
  try {while(true){const part=await reader.read();if(part.done)break;text+=decoder.decode(part.value,{stream:true});}return text+decoder.decode();}
  finally {reader.releaseLock();}
}
export function tail(updates:unknown=[],suggestions:unknown=['观察四周','询问来意','留在原地']){
  return '<sr_extensions><state_update>'+JSON.stringify(updates)+'</state_update><action_suggestions>'+JSON.stringify(suggestions)+'</action_suggestions></sr_extensions>';
}
