import { afterEach,expect,it,vi } from 'vitest';
import { summaryInputLimit,requestFingerprint,assertPreparedRequest,hashRequest,type PreparedRequest } from '../src/runtime/context/budget.js';
import { PiGateway,requiredToolChoice } from '../src/runtime/model/pi-gateway.js';
import { buildContext } from '../src/runtime/context/prompt-builder.js';
import { DEFAULT_CAPABILITIES } from '../src/runtime/config.js';
import type { ContextPolicy } from '../src/runtime/types.js';
import type { Context } from '@earendil-works/pi-ai';
import { runtimeFixture,textGateway,testModel,drain,response } from './fixtures/runtime-v2.js';
import { resolveBudget } from '../src/domain/preset-budget.js';
import { stateTool } from '../src/runtime/tools/state-tool.js';
const policy:ContextPolicy={budget:{strategy:'rolling_summary',max_context_tokens:24000,max_output_tokens:2048},safetyMarginTokens:1024,
  summary:{inputRatio:.75,maxOutputTokens:2048},keepRecentTurns:5};
afterEach(()=>vi.unstubAllGlobals());
it('reserves output and safety within the independent summary budget',()=>{
  expect(summaryInputLimit(testModel,policy)).toBe(24576);
  expect(summaryInputLimit({...testModel,contextWindow:4096},policy)).toBe(1024);
});
it.each([0,-1,1.01,Infinity,NaN])('rejects invalid summary input ratio %s',inputRatio=>{
  expect(()=>summaryInputLimit(testModel,{...policy,summary:{...policy.summary,inputRatio}})).toThrow();
});
it('rejects invalid output reserves and fingerprints every request-affecting input',()=>{
  for(const output of [0,-1,1.5,5000])expect(()=>resolveBudget({...policy.budget,max_output_tokens:output},testModel)).toThrow();
  const context:Context={messages:[{role:'user',content:'中文😀',timestamp:0}]},options={maxTokens:128};
  const fingerprint=requestFingerprint(testModel,context,options);
  const request={mode:'direct',purpose:'generation',model:testModel,context,output:128,fingerprint} as PreparedRequest;
  assertPreparedRequest(request,testModel,context,options);
  expect(()=>assertPreparedRequest(request,{...testModel,id:'other'},context,options)).toThrow();
  expect(()=>assertPreparedRequest(request,testModel,{...context,tools:[stateTool]},options)).toThrow();
  expect(()=>assertPreparedRequest(request,testModel,context,{maxTokens:129})).toThrow();
  expect(()=>assertPreparedRequest(request,testModel,context,{...options,temperature:.1})).toThrow();
});
it('previews text and tool payloads offline while retaining Direct ordering support',async()=>{
  const gateway=new PiGateway(),model=gateway.resolve('deepseek','deepseek-flash')!;
  const network=vi.fn(async()=>{throw Error('offline only');});vi.stubGlobal('fetch',network);
  expect(gateway.supportsDirect(model)).toBe(true);
  expect(gateway.supportsDirect({...model,compat:{...model.compat,supportsMidConvoSystemMessages:false}})).toBe(false);
  const context:Context={messages:[{role:'user',content:'你好😀',timestamp:0}]};
  const plain=await gateway.preview(model,context,{maxTokens:64});
  const withTools=await gateway.preview(model,{...context,tools:[stateTool]},{maxTokens:64,toolChoice:requiredToolChoice(model)});
  expect(plain).toEqual(expect.any(String));expect(withTools).toEqual(expect.any(String));
  expect(withTools).not.toBe(plain);expect(network).not.toHaveBeenCalled();
});
it('previews the same real Pi payload it sends, preserving fixed Direct order with no tool fields',async()=>{
  const gateway=new PiGateway(),model=gateway.resolve('deepseek','deepseek-flash')!;
  const nodes=[
    {id:'userInput',kind:'system' as const,role:'user' as const,enabled:true},
    {id:'postHistory',kind:'system' as const,role:'system' as const,enabled:true,content:'POST_FRONT'},
    {id:'custom',kind:'text' as const,role:'assistant' as const,enabled:true,content:'CUSTOM_FRONT'},
    {id:'main',kind:'system' as const,role:'system' as const,enabled:true,content:'STYLE'},
  ];
  const built=buildContext({characters:[{id:'p',player_selectable:true,prompt:'PLAYER'},{id:'n',prompt:'NPC'}],
    lorebook:{entries:[{id:'l',content:'LORE',load:{mode:'always',order:0}}]}},
    nodes,'p',{global:{},session:{},message:{}},[],'CURRENT',{mode:'direct',capabilities:DEFAULT_CAPABILITIES});
  const context:Context={messages:built.messages([{role:'user',text:'OLD_USER'},{role:'assistant',text:'OLD_STORY'}])};
  let sent:any;const mock=vi.fn(async(_url:unknown,init:RequestInit)=>{
    sent=JSON.parse(String(init.body));
    const chunks=[{id:'t',object:'chat.completion.chunk',created:1,model:'deepseek-flash',choices:[{index:0,delta:{role:'assistant',content:'ok'},finish_reason:null}]},
      {id:'t',object:'chat.completion.chunk',created:1,model:'deepseek-flash',choices:[{index:0,delta:{},finish_reason:'stop'}]}];
    return new Response(chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  });vi.stubGlobal('fetch',mock);
  const wireFingerprint=await gateway.preview(model,context,{maxTokens:64});expect(mock).not.toHaveBeenCalled();
  for await(const _event of gateway.stream(model,context,{apiKey:'fake',signal:new AbortController().signal,maxTokens:64,wireFingerprint})){}
  expect(mock).toHaveBeenCalledTimes(1);expect(hashRequest(sent)).toBe(wireFingerprint);
  expect(sent).not.toHaveProperty('tools');expect(sent).not.toHaveProperty('tool_choice');
  const contents=sent.messages.map((m:any)=>typeof m.content==='string'?m.content:JSON.stringify(m.content));
  const index=(needle:string)=>contents.findIndex((value:string)=>value.includes(needle));
  for(const [a,b] of [['STYLE','POST_FRONT'],['POST_FRONT','CUSTOM_FRONT'],['CUSTOM_FRONT','PLAYER'],['PLAYER','NPC'],['NPC','LORE'],['LORE','OLD_USER'],['OLD_USER','OLD_STORY']] as const){
    expect(index(a)).toBeGreaterThanOrEqual(0);expect(index(a)).toBeLessThan(index(b));
  }
  expect(contents.at(-1)).toBe('CURRENT');expect(contents.filter((v:string)=>v==='CURRENT')).toHaveLength(1);
  expect(sent.messages.at(-2).role).toBe('system');
  mock.mockClear();
  await expect((async()=>{for await(const _event of gateway.stream(model,context,{apiKey:'fake',signal:new AbortController().signal,maxTokens:65,wireFingerprint})){} })()).rejects.toMatchObject({code:'PREPARED_REQUEST_CHANGED'});
  expect(mock).not.toHaveBeenCalled();
});
it('allows protected content above the soft threshold without a local overflow failure',async()=>{
  const gateway=textGateway('story');let calls=0;const stream=gateway.stream;gateway.stream=(...args)=>{calls++;return stream(...args);};
  const {db,runtime}=runtimeFixture(gateway);
  try {
    const run=await runtime.prepare('session','😀'.repeat(90000),'request','opening');await drain(run.stream);
    expect(calls).toBeLessThanOrEqual(2);expect(db.prepare("SELECT count(*) AS count FROM entries WHERE role='user'").get()!.count).toBe(1);
    expect(runtime.status('session',run.runId)).not.toMatchObject({errorCode:'CONTEXT_BUDGET_EXCEEDED'});
  }finally{db.close();}
});
it('sends Agent continuations with complete tool pairs without measuring or reducing them',async()=>{
  let calls=0;
  const gateway=textGateway('unused');
  gateway.stream=(_model,context)=>({async *[Symbol.asyncIterator](){
    calls++;
    if(calls===1)yield {type:'done' as const,reason:'toolUse' as const,message:{...response(''),stopReason:'toolUse' as const,
      content:[{type:'toolCall' as const,id:'huge',name:'update_state',arguments:{updates:[],padding:'x'.repeat(140000)}}]}};
    else {expect(context.messages.slice(-2).map(m=>m.role)).toEqual(['assistant','toolResult']);yield {type:'done' as const,reason:'stop' as const,message:response('done')};}
  }});
  const {db,runtime}=runtimeFixture(gateway,'agent');
  try {
    const run=await runtime.prepare('session','go','request','opening');await drain(run.stream);
    expect(calls).toBe(2);expect(runtime.status('session',run.runId)).toMatchObject({status:'completed'});
  }finally{db.close();}
});
