import { afterEach,expect,it,vi } from 'vitest';
import { countDeepSeekText,inputAllowance,summaryInputLimit,evaluateBudget,requireMeasured,requestFingerprint,assertPreparedRequest,hashRequest,type PreparedRequest } from '../src/runtime/context/budget.js';
import { PiGateway,requiredToolChoice } from '../src/runtime/model/pi-gateway.js';
import { buildContext } from '../src/runtime/context/prompt-builder.js';
import { DEFAULT_CAPABILITIES } from '../src/runtime/config.js';
import type { ContextPolicy } from '../src/runtime/types.js';
import type { Context } from '@earendil-works/pi-ai';
import { runtimeFixture,textGateway,testModel,drain,response } from './fixtures/runtime-v2.js';
import { stateTool } from '../src/runtime/tools/state-tool.js';
const policy:ContextPolicy={windowPreset:'standard',measurement:'current_request',safetyMarginTokens:1024,
  summary:{inputRatio:.75,maxOutputTokens:2048},overflow:{strategy:'summarize_history',keepRecentTurns:5,maxPassesPerRequest:2,maxSummaryCallsPerRun:8}};
afterEach(()=>vi.unstubAllGlobals());
it('subtracts output and safety once, caps model windows, and checks exact boundary',()=>{
  expect(inputAllowance(testModel,policy,2048)).toEqual({effectiveWindow:32768,inputAllowance:29696});
  expect(summaryInputLimit(testModel,policy)).toBe(24576);
  expect(summaryInputLimit({...testModel,contextWindow:4096},policy)).toBe(1024);
  for(const tokens of [29696,29697]){
    const report=evaluateBudget({model:testModel,context:{messages:[]},output:2048,mode:'direct',purpose:'generation',policy,measurement:{tokens,method:'fixture',quality:'exact',version:'1'}});
    expect(report.fits).toBe(tokens===29696);
  }
});
it.each([0,-1,1.01,Infinity,NaN])('rejects invalid summary input ratio %s',inputRatio=>{
  expect(()=>summaryInputLimit(testModel,{...policy,summary:{...policy.summary,inputRatio}})).toThrow();
});
it('rejects invalid output reserves and fingerprints every request-affecting input',()=>{
  for(const output of [0,-1,1.5,5000])expect(()=>inputAllowance(testModel,policy,output)).toThrow();
  const context:Context={messages:[{role:'user',content:'中文😀',timestamp:0}]},options={maxTokens:128};
  const fingerprint=requestFingerprint(testModel,context,options);
  const report=evaluateBudget({model:testModel,context,output:128,mode:'direct',purpose:'generation',policy,measurement:{tokens:10,method:'fixture',quality:'estimated',version:'1'}});
  const request={mode:'direct',purpose:'generation',model:testModel,context,output:128,fingerprint,report} as PreparedRequest;
  assertPreparedRequest(request,testModel,context,options);
  expect(()=>assertPreparedRequest(request,{...testModel,id:'other'},context,options)).toThrow();
  expect(()=>assertPreparedRequest(request,testModel,{...context,tools:[stateTool]},options)).toThrow();
  expect(()=>assertPreparedRequest(request,testModel,context,{maxTokens:129})).toThrow();
  expect(()=>assertPreparedRequest(request,testModel,context,{...options,temperature:.1})).toThrow();
});
it('uses bundled real BPE for multilingual text and labels adapter overhead as estimated',async()=>{
  expect(countDeepSeekText('Hello world')).toBe(2);expect(countDeepSeekText('你好世界')).toBe(2);
  expect(countDeepSeekText('中文😀👩‍🚀')).toBeGreaterThan(0);
  const gateway=new PiGateway(),model=gateway.resolve('deepseek','deepseek-flash')!;
  const network=vi.fn(async()=>{throw Error('offline only');});vi.stubGlobal('fetch',network);
  const plain=await gateway.measure(model,{messages:[{role:'user',content:'你好😀',timestamp:0}]},{maxTokens:64});
  const withTools=await gateway.measure(model,{messages:[{role:'user',content:'你好😀',timestamp:0}],tools:[stateTool]},{maxTokens:64,toolChoice:requiredToolChoice(model)});
  expect(plain).toMatchObject({quality:'estimated',method:'deepseek-v41-bpe-wire-estimate',wireFingerprint:expect.any(String)});
  expect(withTools.tokens!).toBeGreaterThan(plain.tokens!);expect(network).not.toHaveBeenCalled();
  expect((await gateway.measure({...model,id:'unsupported'},{messages:[]},{maxTokens:64})).quality).toBe('unknown');
  expect((await gateway.measure(model,{messages:[{role:'user',content:[{type:'image',data:'x',mimeType:'image/png'}],timestamp:0}]},{maxTokens:64})).quality).toBe('unknown');
},15000);
it('measures the same real Pi payload it sends, preserving fixed Direct order with no tool fields',async()=>{
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
  const measurement=await gateway.measure(model,context,{maxTokens:64});expect(mock).not.toHaveBeenCalled();
  for await(const _event of gateway.stream(model,context,{apiKey:'fake',signal:new AbortController().signal,maxTokens:64,wireFingerprint:measurement.wireFingerprint})){}
  expect(mock).toHaveBeenCalledTimes(1);expect(hashRequest(sent)).toBe(measurement.wireFingerprint);
  expect(sent).not.toHaveProperty('tools');expect(sent).not.toHaveProperty('tool_choice');
  const contents=sent.messages.map((m:any)=>typeof m.content==='string'?m.content:JSON.stringify(m.content));
  const index=(needle:string)=>contents.findIndex((value:string)=>value.includes(needle));
  for(const [a,b] of [['STYLE','POST_FRONT'],['POST_FRONT','CUSTOM_FRONT'],['CUSTOM_FRONT','PLAYER'],['PLAYER','NPC'],['NPC','LORE'],['LORE','OLD_USER'],['OLD_USER','OLD_STORY']] as const){
    expect(index(a)).toBeGreaterThanOrEqual(0);expect(index(a)).toBeLessThan(index(b));
  }
  expect(contents.at(-1)).toBe('CURRENT');expect(contents.filter((v:string)=>v==='CURRENT')).toHaveLength(1);
  expect(sent.messages.at(-2).role).toBe('system');
  mock.mockClear();
  await expect((async()=>{for await(const _event of gateway.stream(model,context,{apiKey:'fake',signal:new AbortController().signal,maxTokens:65,wireFingerprint:measurement.wireFingerprint})){} })()).rejects.toMatchObject({code:'PREPARED_REQUEST_CHANGED'});
  expect(mock).not.toHaveBeenCalled();
});
it('rejects a sudden protected input increase before any generation even if previous usage is small',async()=>{
  const gateway=textGateway('must not run');let calls=0;const stream=gateway.stream;gateway.stream=(...args)=>{calls++;return stream(...args);};
  const {db,runtime}=runtimeFixture(gateway);
  try {
    await expect(runtime.prepare('session','😀'.repeat(90000),'request','opening')).rejects.toMatchObject({code:'CONTEXT_BUDGET_EXCEEDED'});
    expect(calls).toBe(0);expect(db.prepare("SELECT count(*) AS count FROM entries WHERE role='user'").get()!.count).toBe(0);
  }finally{db.close();}
});
it('remeasures Agent continuations with complete tool pairs and refuses oversized current tool traffic',async()=>{
  let calls=0;
  const gateway=textGateway('unused');
  gateway.stream=()=>({async *[Symbol.asyncIterator](){
    calls++;yield {type:'done' as const,reason:'toolUse' as const,message:{...response(''),stopReason:'toolUse' as const,
      content:[{type:'toolCall' as const,id:'huge',name:'unknown',arguments:{text:'x'.repeat(140000)}}]}};
  }});
  const {db,runtime}=runtimeFixture(gateway,'agent');
  try {
    const run=await runtime.prepare('session','go','request','opening');await drain(run.stream);
    expect(calls).toBe(1);expect(runtime.status('session',run.runId)).toMatchObject({status:'failed',errorCode:'CONTEXT_BUDGET_EXCEEDED'});
    const messages=db.prepare("SELECT role,payload FROM entries WHERE run_id=? AND role!='user' ORDER BY seq").all(run.runId);
    expect(messages.map(m=>m.role)).toEqual(['assistant','toolResult']);
    expect(JSON.parse(String(messages[1]!.payload)).message.toolCallId).toBe('huge');
  }finally{db.close();}
});

it.each([null,NaN,Infinity,-1,1.5])('rejects invalid meter result %s instead of attempting compaction',tokens=>{
  const report=evaluateBudget({model:testModel,context:{messages:[]},output:128,mode:'direct',purpose:'generation',policy,
    measurement:{tokens,method:'fixture',quality:'estimated',version:'1'}});
  expect(report.fits).toBe(false);
  expect(()=>requireMeasured(report)).toThrowError(expect.objectContaining({code:'CONTEXT_MEASUREMENT_UNSUPPORTED'}));
});
