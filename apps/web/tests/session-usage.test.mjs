import {i18n} from '../src/i18n/instance.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cacheHitRate,contextRatio,contextSegments,contextSummary,cumulativeSegments} from '../src/features/sessions/usage.ts';

const knownUsage={inputTokens:100,outputTokens:30,totalTokens:130,cacheReadTokens:40,cacheWriteTokens:10};
test('cumulative segments separate cached input without counting it twice',()=>{
  const segments=cumulativeSegments(knownUsage);
  assert.deepEqual(segments.map(({key,value})=>({key,value})),[
    {key:'input',value:50},{key:'read',value:40},{key:'write',value:10},{key:'output',value:30},
  ]);
  assert.equal(segments.reduce((sum,item)=>sum+item.value,0),130);
  assert.equal(cacheHitRate({knownUsage,recordedRequestCount:2,unknownUsageRequestCount:0}),.4);
});
test('unknown calls and zero input do not masquerade as a complete cache rate',()=>{
  assert.equal(cacheHitRate({knownUsage,recordedRequestCount:2,unknownUsageRequestCount:1}),null);
  assert.equal(cacheHitRate({knownUsage:{...knownUsage,inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0},recordedRequestCount:0,unknownUsageRequestCount:0}),null);
});
test('context composition uses only recorded bytes and never derives categories from token usage',()=>{
  assert.deepEqual(contextSegments(undefined),[]);
  assert.deepEqual(contextSegments(null),[]);
  assert.deepEqual(contextSegments({systemBytes:0,summaryBytes:0,historyBytes:0}),[]);
  const segments=contextSegments({systemBytes:20,summaryBytes:30,historyBytes:50});
  assert.deepEqual(segments.map(({key,ratio})=>({key,ratio})),[
    {key:'system',ratio:.2},{key:'summary',ratio:.3},{key:'history',ratio:.5},
  ]);
});
test('a missing context or measurement remains unknown while real input/window yields a ratio',()=>{
  assert.equal(contextSummary(null),'暂无');
  const context={inputTokens:8000,contextWindowTokens:64000,modelId:'m',stale:false};
  assert.equal(contextRatio(context),.125);
  assert.equal(contextSummary(context),'8,000 / 6.4万 · 12.5%');
  assert.equal(contextSummary({...context,inputTokens:null}),'用量未知 / 6.4万');
  assert.equal(contextRatio({...context,inputTokens:null}),null);
  assert.equal(contextSummary({...context,contextWindowTokens:null}),'8,000 / 窗口未提供');
  assert.equal(contextRatio({...context,contextWindowTokens:0}),null);
});

test('usage display follows the active language without changing recorded measurements',async()=>{
  const context={inputTokens:8000,contextWindowTokens:64000,modelId:'m',stale:false};
  const before=structuredClone(knownUsage);
  await i18n.changeLanguage('en');
  try{
    assert.equal(contextSummary(context),'8,000 / 64K · 12.5%');
    assert.equal(contextSummary({...context,inputTokens:null}),'Usage unknown / 64K');
    assert.equal(contextSummary(null),'None');
    assert.deepEqual(cumulativeSegments(knownUsage).map(item=>item.label),['Input','Cache read','Cache write','Output']);
    assert.deepEqual(knownUsage,before);
    await i18n.changeLanguage('ja');
    assert.equal(contextSummary(context),'8,000 / 6.4万 · 12.5%');
    assert.equal(contextSummary({...context,inputTokens:null}),'使用量不明 / 6.4万');
    assert.equal(contextSummary(null),'なし');
    assert.deepEqual(cumulativeSegments(knownUsage).map(item=>item.label),['入力','キャッシュ読み取り','キャッシュ書き込み','出力']);
    assert.deepEqual(contextSegments({systemBytes:20,summaryBytes:30,historyBytes:50}).map(item=>item.label),['システム','要約','履歴']);
    assert.deepEqual(knownUsage,before);
  }finally{await i18n.changeLanguage('zh-CN');}
  assert.equal(contextSummary(context),'8,000 / 6.4万 · 12.5%');
});
