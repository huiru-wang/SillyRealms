import { expect,it } from 'vitest';
import type { AssistantMessageEvent,Message } from '@earendil-works/pi-ai';
import { generateSummary } from '../src/runtime/context/compaction/summary-generator.js';
import { response } from './fixtures/runtime-v2.js';
it('sends all selected unicode text, instructions, gaps and previous summary in exactly one request', async () => {
  const calls: Message[][] = [];
  const history = [{ id: 'old', role: 'assistant' as const, text: '中文😀'.repeat(2500), gap: 'stopped:cancelled' }];
  const text = await generateSummary({ previous: 'previous', history, prompt: 'instructions', gaps: ['stopped:cancelled'],
    limit: 30000, signal: new AbortController().signal, generate: async messages => {
      calls.push(messages); return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: 'stop', message: response('short summary') } as AssistantMessageEvent; } };
    } });
  expect(text).toBe('short summary'); expect(calls).toHaveLength(1);
  const request = JSON.parse(String(calls[0]![1]!.content));
  expect(request.previous).toBe('previous'); expect(request.messages[0].text).toBe(history[0]!.text);
  expect(request.messages[0].gap).toBe('stopped:cancelled');
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
  await expect(generateSummary({previous:null,history:[{id:'x',role:'assistant',text:'facts'}],limit:10000,
    prompt:'instructions',gaps:[],signal:new AbortController().signal,
    generate:async()=>({async *[Symbol.asyncIterator](){yield* events;}}),
  })).rejects.toMatchObject({code:variant==='empty'?'SUMMARY_EMPTY':'SUMMARY_FAILED'});
});
it('does not recursively summarize when fixed instructions/previous summary consume the budget',async()=>{
  let calls=0;
  await expect(generateSummary({previous:'x'.repeat(5000),history:[{id:'x',role:'assistant',text:'facts'}],limit:1000,
    prompt:'instructions',gaps:[],signal:new AbortController().signal,
    generate:async()=>{calls++;return {async *[Symbol.asyncIterator](){}};},
  })).rejects.toMatchObject({code:'SUMMARY_CAPACITY_EXCEEDED'});
  expect(calls).toBe(0);
});
it.each([32768,131072,262144,524288])('summarizes a complete long source once at model window %s',async window=>{
  const {summaryInputLimit}=await import('../src/runtime/context/budget.js');
  const {testModel}=await import('./fixtures/runtime-v2.js');
  const model={...testModel,contextWindow:window};
  const policy={budget:{strategy:'rolling_summary' as const,max_context_tokens:Math.floor(window*.8),max_output_tokens:128},
    safetyMarginTokens:1024,keepRecentTurns:5,summary:{inputRatio:.75,maxOutputTokens:2048}};
  const source='中'.repeat(window/2);let calls=0;
  const result=await generateSummary({previous:'old',history:[{id:'prefix',role:'assistant',text:source}],prompt:'summarize',gaps:[],
    limit:summaryInputLimit(model,policy),signal:new AbortController().signal,generate:async messages=>{
      calls++;expect(JSON.parse(String(messages[1]!.content)).messages[0].text).toBe(source);
      return {async *[Symbol.asyncIterator](){yield {type:'done' as const,reason:'stop' as const,message:response('complete summary')};}};
    }});
  expect(result).toBe('complete summary');expect(calls).toBe(1);
});
