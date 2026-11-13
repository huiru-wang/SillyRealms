import { expect,it } from 'vitest';
import type { AssistantMessageEvent,Message } from '@earendil-works/pi-ai';
import { summarizeInBudget } from '../src/runtime/context/history-compactor.js';
import { evaluateBudget,type PreparedRequest } from '../src/runtime/context/budget.js';
import { testModel,response } from './fixtures/runtime-v2.js';
import type { ContextPolicy } from '../src/runtime/types.js';
const policy:ContextPolicy={windowPreset:'standard',measurement:'current_request',safetyMarginTokens:100,
  summary:{inputRatio:.75,maxOutputTokens:100},overflow:{strategy:'summarize_history',keepRecentTurns:5,maxPassesPerRequest:2,maxSummaryCallsPerRun:8}};
async function prepare(messages:Message[]):Promise<PreparedRequest>{
  const model={...testModel,contextWindow:4000},context={messages},tokens=Array.from(JSON.stringify(context)).length;
  const report=evaluateBudget({model,context,output:100,mode:'direct',purpose:'summary',policy,measurement:{tokens,quality:'estimated',method:'fixture',version:'1'}});
  return {mode:'direct',purpose:'summary',model,context,output:100,fingerprint:report.fingerprint,report};
}
it('budgets the previous summary, instructions, gaps, wrapper and each unicode-safe chunk',async()=>{
  const calls:PreparedRequest[]=[];
  const text=await summarizeInBudget({previous:'previous',chunks:[{id:'old',role:'assistant',text:'中文😀'.repeat(2500),gap:'stopped:cancelled'}]},{
    prompt:'summary instructions',gaps:['stopped:cancelled'],signal:new AbortController().signal,prepare,
    generate:async request=>{calls.push(request);return {async *[Symbol.asyncIterator](){yield {type:'done',reason:'stop',message:response('short summary')} as AssistantMessageEvent;}};},
  });
  expect(text).toBe('short summary');expect(calls.length).toBeGreaterThan(1);expect(calls.every(c=>c.report.fits&&c.report.inputAllowance===3000)).toBe(true);
  const chunks=calls.flatMap(c=>JSON.parse(String(c.context.messages[1]!.content)).messages);
  expect(chunks.map(c=>c.text).join('')).toBe('中文😀'.repeat(2500));
  expect(chunks.every(c=>c.gap==='stopped:cancelled')).toBe(true);
  expect(JSON.parse(String(calls[1]!.context.messages[1]!.content)).previous).toBe('short summary');
});
it.each(['length','empty','duplicate','late','mismatch','tool','error'] as const)('rejects abnormal summary result %s',async variant=>{
  const done={type:'done',reason:'stop',message:response('summary')} as AssistantMessageEvent;
  const events:AssistantMessageEvent[]=variant==='length'?[{type:'done',reason:'length',message:response('summary','length')} as AssistantMessageEvent]:
    variant==='empty'?[{type:'done',reason:'stop',message:response('')} as AssistantMessageEvent]:
    variant==='duplicate'?[done,done]:
    variant==='late'?[done,{type:'text_delta',delta:'late',contentIndex:0,partial:{} as never}]:
    variant==='mismatch'?[{type:'text_delta',delta:'different',contentIndex:0,partial:{} as never},done]:
    variant==='tool'?[{type:'done',reason:'toolUse',message:{...response(''),stopReason:'toolUse',content:[{type:'toolCall',id:'x',name:'x',arguments:{}}]}} as AssistantMessageEvent]:
    [{type:'error',reason:'error',error:{...response(''),stopReason:'error'}} as AssistantMessageEvent];
  await expect(summarizeInBudget({previous:null,chunks:[{id:'x',role:'assistant',text:'facts'}]},{
    prompt:'instructions',gaps:[],signal:new AbortController().signal,prepare,
    generate:async()=>({async *[Symbol.asyncIterator](){yield* events;}}),
  })).rejects.toMatchObject({code:'SUMMARY_FAILED'});
});
it('does not recursively summarize when fixed instructions/previous summary consume the budget',async()=>{
  let calls=0;
  await expect(summarizeInBudget({previous:'x'.repeat(5000),chunks:[{id:'x',role:'assistant',text:'facts'}]},{
    prompt:'instructions',gaps:[],signal:new AbortController().signal,prepare,
    generate:async()=>{calls++;return {async *[Symbol.asyncIterator](){}};},
  })).rejects.toMatchObject({code:'CONTEXT_BUDGET_EXCEEDED'});
  expect(calls).toBe(0);
});
