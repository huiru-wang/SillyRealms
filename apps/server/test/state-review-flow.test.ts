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

async function exercise(stateEnabled:boolean, updates:Array<{path:string,value:unknown}>) {
  const db=openDatabase(':memory:');
  const calls:Array<{choice?:ToolChoice,tools:string[],payload:string}>=[];
  const gateway:ModelGateway={resolve:()=>model,toolVerified:()=>true,stream:(_m,context,opts)=>({
    async *[Symbol.asyncIterator]() {
      const tools=context.tools?.map(t=>t.name)??[];
      calls.push({choice:opts.toolChoice,tools,payload:JSON.stringify(context.messages)});
      const done=opts.toolChoice===('required' as ToolChoice)
        ? reply([{type:'toolCall',id:'review',name:'review_state',arguments:{updates}}],'toolUse')
        : reply([{type:'text',text:'故事推进了一步'}],'stop');
      yield {type:'done',reason:done.stopReason,message:done} as AssistantMessageEvent;
    },
  })};
  try {
    const card={spec:'world_card',spec_version:'0.1',data:{
      name:'Test',
      characters:[{id:'p',name:'P',player_selectable:true},{id:'c',name:'C',prompt:'SECRET_CHARACTER'}],
      openings:[{id:'o',name:'O',content:'hello'}],
      ...(stateEnabled?{state:{schema_version:1,scopes:{message:{阶段:{type:'string',initial:'初始',description:'只在明确行动后修改'}}}}}:{})
    }};
    seedWorld(db,'world',card);
    const app=createApp(db,fakeCredentials,gateway);
    const response=await app.request('/api/v1/sessions',post({worldId:'world',openingId:'o',userCharacterId:'p'}));
    expect(response.status).toBe(201);
    const json=await response.json() as {data:{item:{id:string,tipEntryId:string}}};
    const session=json.data.item;
    const runtime=new AgentRuntime(db,fakeCredentials,gateway);
    const {runId,stream}=await runtime.prepare(session.id,'继续','req-1',session.tipEntryId);
    const reader=stream.getReader();
    while (!(await reader.read()).done) { /* drain */ }
    expect(runtime.status(session.id,runId)?.status).toBe('completed');
    const state=await (await app.request('/api/v1/sessions/'+session.id+'/state')).json() as {data:{message:Record<string,unknown>}};
    const tools=db.prepare("SELECT count(*) as count FROM entries WHERE session_id=? AND role='toolResult'").get(session.id)?.count;
    return {calls,state:state.data.message,tools};
  } finally {db.close();}
}

it('forces a compact state review when narration omitted update_state',async()=>{
  const {calls,state,tools}=await exercise(true,[{path:'阶段',value:'推进'}]);
  expect(calls).toHaveLength(2);
  expect(calls[0]?.tools).toEqual(['update_state']);
  expect(calls[0]?.choice).toBeUndefined();
  expect(calls[1]?.tools).toEqual(['review_state']);
  expect(calls[1]?.choice).toBe('required');
  expect(calls[1]?.payload).not.toContain('SECRET_CHARACTER');
  expect(state.阶段).toBe('推进');
  expect(tools).toBe(1);
});
it('accepts a no-change verdict without inventing a mutation',async()=>{
  const {calls,state}=await exercise(true,[]);
  expect(calls).toHaveLength(2);
  expect(state.阶段).toBe('初始');
});
it('skips forced review if no message state is active',async()=>{
  const {calls,tools}=await exercise(false,[]);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.tools).toEqual([]);
  expect(tools).toBe(0);
});
