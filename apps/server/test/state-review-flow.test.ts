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

async function exercise(stateEnabled:boolean, updates:Array<{path:string,value:unknown}>,omitTool=false,override?:unknown[], later?:unknown[][]) {
  const db=openDatabase(':memory:');
  const calls:Array<{choice?:ToolChoice,tools:string[],payload:string}>=[];
  const gateway:ModelGateway={resolve:()=>model,toolVerified:()=>true,stream:(_m,context,opts)=>({
    async *[Symbol.asyncIterator]() {
      const tools=context.tools?.map(t=>t.name)??[];
      calls.push({choice:opts.toolChoice,tools,payload:JSON.stringify(context.messages)});
      const content:unknown[]=calls.length > 1 ? later?.[calls.length-2] ?? [{type:'text',text:'故事继续'}] : override ?? [{type:'text',text:'故事推进了一步'}];
      if (calls.length === 1 && !override && stateEnabled && !omitTool) content.push({type:'toolCall',id:'state',name:'update_state',arguments:{updates}});
      const done=reply(content,content.some(part => (part as {type:string}).type === 'toolCall')?'toolUse':'stop');
      for (const part of content) if ((part as {type:string}).type==='text')
        yield {type:'text_delta',contentIndex:0,delta:(part as {text:string}).text,partial:{} as never} as AssistantMessageEvent;
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
    const events:Array<{type:string;payload:Record<string,unknown>}>=[];
    runtime.onEvent((_id,type,payload)=>events.push({type,payload}));
    const {runId,stream}=await runtime.prepare(session.id,'继续','req-1',session.tipEntryId);
    const reader=stream.getReader();let output='';while (true) {const part=await reader.read();if(part.done)break;output+=new TextDecoder().decode(part.value);}
    const status=runtime.status(session.id,runId)?.status;
    const state=await (await app.request('/api/v1/sessions/'+session.id+'/state')).json() as {data:{message:Record<string,unknown>}};
    const rows=db.prepare("SELECT payload FROM entries WHERE session_id=? AND role='toolResult' ORDER BY seq").all(session.id);
    const toolResults=rows.map(row=>JSON.parse(String(row.payload)).message as {isError:boolean;toolCallId:string;content:Array<{type:string;text:string}>});
    const messages=db.prepare("SELECT payload FROM entries WHERE session_id=? AND run_id=? AND role='assistant' ORDER BY seq").all(session.id,runId)
      .map(row=>JSON.parse(String(row.payload)).message.content);
    return {calls,state:state.data.message,tools:toolResults.length,toolResults,status,events,output,messages};
  } finally {db.close();}
}

it('continues after a state update and commits all changes',async()=>{
  const {calls,state,tools,status}=await exercise(true,[{path:'阶段',value:'推进'},{path:'计数',value:1}]);
  expect(status).toBe('completed');
  expect(calls).toHaveLength(2);
  expect(calls[0]?.tools).toEqual(['update_state']);
  expect(calls[0]?.choice).toBe('required');
  expect(calls[1]?.choice).toBeUndefined();
  expect(calls[1]?.payload).toContain('toolResult');
  expect(calls[0]?.payload).toContain('【状态更新判断】');
  expect(calls[0]?.payload).toContain('【可更新状态】');
  expect(state).toMatchObject({阶段:'推进',计数:1});
  expect(tools).toBe(1);
});
it('submits empty updates without inventing state changes',async()=>{
  const {calls,state,status}=await exercise(true,[]);
  expect(status).toBe('completed');expect(calls).toHaveLength(2);
  expect(state).toMatchObject({阶段:'初始',计数:0});
});
it('reports invalid state batches without failing narration or applying partial updates',async()=>{
  const {calls,state,status,toolResults,events}=await exercise(true,[{path:'阶段',value:'推进'},{path:'计数',value:-1}]);
  expect(status).toBe('completed');expect(calls).toHaveLength(2);
  expect(state).toMatchObject({阶段:'初始',计数:0});
  expect(toolResults).toHaveLength(1);
  expect(toolResults[0]?.isError).toBe(true);
  expect(events.filter(e=>e.type==='tool.failed')).toMatchObject([
    {payload:{toolCallId:'state',toolName:'update_state',errorCode:'STATE_OUT_OF_RANGE',errorMessage:'状态值超出允许范围'}},
  ]);
  expect(events.at(-1)).toMatchObject({type:'run.updated',payload:{status:'completed'}});
});
it('fails the Run if a model ignores the required state tool',async()=>{
  const {calls,state,status,toolResults,events}=await exercise(true,[],true);
  expect(status).toBe('failed');expect(calls).toHaveLength(1);
  expect(calls[0]?.choice).toBe('required');
  expect(toolResults).toHaveLength(0);
  expect(events.some(e=>e.type==='tool.failed')).toBe(false);
  expect(state.阶段).toBe('初始');
});
it('accepts tools before and between narrative text, with multiple calls',async()=>{
  const content=[
    {type:'toolCall',id:'first',name:'update_state',arguments:{updates:[{path:'计数',value:2}]}},
    {type:'text',text:'故事推进'},
    {type:'toolCall',id:'second',name:'update_state',arguments:{updates:[{path:'阶段',value:'第二幕'}]}},
    {type:'text',text:'故事继续'},
  ];
  const {calls,status,state,toolResults,events}=await exercise(true,[],false,content);
  expect(status).toBe('completed');expect(calls).toHaveLength(2);
  expect(state).toMatchObject({阶段:'第二幕',计数:2});
  expect(toolResults).toHaveLength(2);
  expect(toolResults.every(result=>!result.isError)).toBe(true);
  expect(events.some(e=>e.type==='tool.failed')).toBe(false);
});
it('continues executing later tools after a failed call',async()=>{
  const content=[
    {type:'text',text:'故事推进'},
    {type:'toolCall',id:'broken',name:'update_state',arguments:{updates:[{path:'计数',value:-5}]}},
    {type:'toolCall',id:'valid',name:'update_state',arguments:{updates:[{path:'阶段',value:'推进'}]}},
    {type:'toolCall',id:'unknown',name:'nonexistent',arguments:{}},
  ];
  const {status,state,toolResults,events}=await exercise(true,[],false,content);
  expect(status).toBe('completed');
  expect(state).toMatchObject({阶段:'推进',计数:0});
  expect(toolResults.map(result=>result.isError)).toEqual([true,false,true]);
  expect(events.filter(e=>e.type==='tool.failed').map(e=>e.payload.errorCode))
    .toEqual(['STATE_OUT_OF_RANGE','INVALID_TOOL_CALL']);
});
it('continues after a tool-only reply so the model can produce narrative',async()=>{
  const content=[{type:'toolCall',id:'state',name:'update_state',arguments:{updates:[]}}];
  const {status,toolResults,calls,output}=await exercise(true,[],false,content);
  expect(status).toBe('completed');expect(toolResults).toHaveLength(1);
  expect(calls).toHaveLength(2);
  expect(output).toBe('故事继续');
});
it('runs multiple model and tool exchanges, preserving streamed messages in order',async()=>{
  const tool=(id:string,value:number)=>({type:'toolCall',id,name:'update_state',arguments:{updates:[{path:'计数',value}]}});
  const {calls,status,state,toolResults,output,messages}=await exercise(true,[],false,
    [{type:'text',text:'开头'},tool('first',1)],
    [[{type:'text',text:'中间'},tool('second',2)],[{type:'text',text:'结尾'}]]);
  expect(status).toBe('completed');expect(calls).toHaveLength(3);
  expect(output).toBe('开头中间结尾');expect(state.计数).toBe(2);
  expect(toolResults).toHaveLength(2);
  expect(JSON.parse(calls[2]!.payload).filter((m:{role:string})=>m.role==='toolResult')).toHaveLength(2);
  expect(messages.map((parts:Array<{type:string;text?:string}>)=>parts.find(p=>p.type==='text')?.text)).toEqual(['开头','中间','结尾']);
});
it('does not request tools when there is no writable message state',async()=>{
  const {calls,tools,status}=await exercise(false,[]);
  expect(status).toBe('completed');expect(calls).toHaveLength(1);
  expect(calls[0]?.tools).toEqual([]);expect(calls[0]?.choice).toBeUndefined();
  expect(tools).toBe(0);
});
