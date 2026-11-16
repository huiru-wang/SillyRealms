import { afterEach,expect,it,vi } from 'vitest';
import { summaryInputLimit,requestFingerprint,assertPreparedRequest,hashRequest,type PreparedRequest } from '../src/runtime/context/budget.js';
import { PiGateway } from '../src/runtime/model/pi-gateway.js';
import {compileContext} from '../src/runtime/context/node-compiler.js';
import {contextFixture} from './fixtures/context.js';
import type { ContextPolicy } from '../src/runtime/types.js';
import type { Context } from '@earendil-works/pi-ai';
import { runtimeFixture,textGateway,testModel,drain } from './fixtures/runtime-v2.js';
import { resolveBudget } from '../src/domain/preset-budget.js';
const stateTool={name:'forbidden',description:'forbidden',parameters:{type:'object'}} as any;
const policy:ContextPolicy={budget:{strategy:'rolling_summary',max_context_tokens:24000,max_output_tokens:2048},safetyMarginTokens:1024,
  summary:{prompt:'summarize',inputRatio:.75,maxOutputTokens:2048},keepRecentTurns:5};
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
  const request={purpose:'generation',model:testModel,context,output:128,fingerprint} as PreparedRequest;
  assertPreparedRequest(request,testModel,context,options);
  expect(()=>assertPreparedRequest(request,{...testModel,id:'other'},context,options)).toThrow();
  expect(()=>assertPreparedRequest(request,testModel,{...context,tools:[stateTool]},options)).toThrow();
  expect(()=>assertPreparedRequest(request,testModel,context,{maxTokens:129})).toThrow();
  expect(()=>assertPreparedRequest(request,testModel,context,{...options,temperature:.1})).toThrow();
  expect(()=>assertPreparedRequest(request,testModel,context,{...options,reasoning:'medium'})).toThrow();
});
it.each([false,true])('previews the same real Pi payload, preserving Direct order with thinking=%s',async thinkingEnabled=>{
  const gateway=new PiGateway(),model=gateway.resolve('deepseek','deepseek-flash')!;
  const built=compileContext(contextFixture());
  const context:Context={messages:built.messages};
  let sent:any;const mock=vi.fn(async(_url:unknown,init:RequestInit)=>{
    sent=JSON.parse(String(init.body));
    const chunks=[{id:'t',object:'chat.completion.chunk',created:1,model:'deepseek-flash',choices:[{index:0,delta:{role:'assistant',content:'ok'},finish_reason:null}]},
      {id:'t',object:'chat.completion.chunk',created:1,model:'deepseek-flash',choices:[{index:0,delta:{},finish_reason:'stop'}]}];
    return new Response(chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  });vi.stubGlobal('fetch',mock);
  const options={maxTokens:64,reasoning:thinkingEnabled?'medium' as const:undefined};
  const wireFingerprint=await gateway.preview(model,context,options);expect(mock).not.toHaveBeenCalled();
  const opposite=await gateway.preview(model,context,{...options,reasoning:thinkingEnabled?undefined:'medium'});
  expect(opposite).not.toBe(wireFingerprint);
  for await(const _event of gateway.stream(model,context,{...options,apiKey:'fake',signal:new AbortController().signal,wireFingerprint})){}
  expect(mock).toHaveBeenCalledTimes(1);expect(hashRequest(sent)).toBe(wireFingerprint);
  expect(sent).not.toHaveProperty('tools');expect(sent).not.toHaveProperty('tool_choice');
  expect(sent.thinking).toEqual({type:thinkingEnabled?'enabled':'disabled'});
  if(thinkingEnabled)expect(sent.reasoning_effort).toBe('high');else expect(sent).not.toHaveProperty('reasoning_effort');
  const contents=sent.messages.map((m:any)=>typeof m.content==='string'?m.content:JSON.stringify(m.content));
  const index=(needle:string)=>contents.findIndex((value:string)=>value.includes(needle));
  const nodeIndex=(tag:string)=>contents.findIndex((value:string)=>value.startsWith(`${tag}\n`));
  expect(index('OLD_STORY')).toBeLessThan(index('CURRENT forest'));
  expect(index('CURRENT forest')).toBeLessThan(nodeIndex('<世界状态>'));
  expect(nodeIndex('<世界状态>')).toBeLessThan(nodeIndex('<行动建议>'));

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
