import {expect,it} from 'vitest';
import type {Api,AssistantMessageEvent,Model,ToolChoice} from '@earendil-works/pi-ai';
import type {ModelGateway} from '../src/agent/model/pi-gateway.js';
import {openDatabase} from '../src/infrastructure/database/database.js';
import {createApp} from '../src/app.js';
import {AgentRuntime} from '../src/agent/runtime/agent-runtime.js';
import {fakeCredentials,seedWorld} from './fixtures/db-seed.js';

const model:Model<Api>={id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://localhost',input:['text'],reasoning:false,contextWindow:32768,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const reply=(content:unknown[],stopReason:'stop'|'toolUse')=>({role:'assistant' as const,content,api:'openai-completions',provider:'fake',model:'fake',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason,timestamp:Date.now()});
const post=(body:unknown)=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});

async function exercise(stateEnabled:boolean, updates:Array<{path:string,value:unknown}>,omitTool=false) {
  const db=openDatabase(':memory:');
  const calls:Array<{choice?:ToolChoice,tools:string[],payload:string}>=[];
  const gateway:ModelGateway={resolve:()=>model,toolVerified:()=>true,stream:(_m,context,opts)=>({
    async *[Symbol.asyncIterator]() {
      const tools=context.tools?.map(t=>t.name)??[];
      calls.push({choice:opts.toolChoice,tools,payload:JSON.stringify(context.messages)});
      const content:unknown[]=[{type:'text',text:'故事推进了一步'}];
      if (stateEnabled && !omitTool) content.push({type:'toolCall',id:'state',name:'update_state',arguments:{updates}});
      const done=reply(content,content.length>1?'toolUse':'stop');
      yield {type:'done',reason:done.stopReason,message:done} as AssistantMessageEvent;
    },
  })};
  try {
    const card={spec:'world_card',spec_version:'0.1',data:{
      name:'Test', characters:[{id:'p',name:'P',player_selectable:true},{id:'c',name:'C',prompt:'SECRET_CHARACTER'}],
      openings:[{id:'o',name:'O',content:'hello'}],
      ...(stateEnabled?{state:{schema_version:1,scopes:{message:{阶段:{type:'string',initial:'初始',description:'只在明确行动后修改'},计数:{type:'number',initial:0,min:0}}}}}:{})
    }};
    seedWorld(db,'world',card);
    const app=createApp(db,fakeCredentials,gateway);
    const response=await app.request('/api/v1/sessions',post({worldId:'world',openingId:'o',userCharacterId:'p'}));
    expect(response.status).toBe(201);
    const json=await response.json() as {data:{item:{id:string,tipEntryId:string}}};
    const session=json.data.item;
    const runtime=new AgentRuntime(db,fakeCredentials,gateway);
    const {runId,stream}=await runtime.prepare(session.id,'继续','req-1',session.tipEntryId);
    const reader=stream.getReader();while (!(await reader.read()).done) { /* drain */ }
    const status=runtime.status(session.id,runId)?.status;
    const state=await (await app.request('/api/v1/sessions/'+session.id+'/state')).json() as {data:{message:Record<string,unknown>}};
    const tools=db.prepare("SELECT count(*) as count FROM entries WHERE session_id=? AND role='toolResult'").get(session.id)?.count;
    return {calls,state:state.data.message,tools,status};
  } finally {db.close();}
}

it('forces one batch update_state call within the narrative request and commits all changes',async()=>{
  const {calls,state,tools,status}=await exercise(true,[{path:'阶段',value:'推进'},{path:'计数',value:1}]);
  expect(status).toBe('completed');
  expect(calls).toHaveLength(1);
  expect(calls[0]?.tools).toEqual(['update_state']);
  expect(calls[0]?.choice).toBe('required');
  expect(calls[0]?.payload).toContain('【状态更新判断】');
  expect(calls[0]?.payload).toContain('【可更新状态】');
  expect(state).toMatchObject({阶段:'推进',计数:1});
  expect(tools).toBe(1);
});
it('submits empty updates without inventing state changes',async()=>{
  const {calls,state,status}=await exercise(true,[]);
  expect(status).toBe('completed');expect(calls).toHaveLength(1);
  expect(state).toMatchObject({阶段:'初始',计数:0});
});
it('rejects invalid batches atomically without a review retry',async()=>{
  const {calls,state,status}=await exercise(true,[{path:'阶段',value:'推进'},{path:'计数',value:-1}]);
  expect(status).toBe('failed');expect(calls).toHaveLength(1);
  expect(state).toMatchObject({阶段:'初始',计数:0});
});
it('fails if a provider ignores mandatory tool choice instead of silently skipping state',async()=>{
  const {calls,state,status}=await exercise(true,[],true);
  expect(status).toBe('failed');expect(calls).toHaveLength(1);
  expect(state.阶段).toBe('初始');
});
it('does not request tools when there is no writable message state',async()=>{
  const {calls,tools,status}=await exercise(false,[]);
  expect(status).toBe('completed');expect(calls).toHaveLength(1);
  expect(calls[0]?.tools).toEqual([]);expect(calls[0]?.choice).toBeUndefined();
  expect(tools).toBe(0);
});
