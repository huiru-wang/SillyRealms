import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cacheDuration,changeProvider,findCatalogModel,keepsSavedSelection,modelDraft,modelDraftError,modelFacts} from '../src/features/models/catalog.ts';

const model=(providerId,overrides={})=>({
 providerId,modelId:'shared-id',name:'SDK model',contextWindow:131072,maxTokens:8192,
 reasoning:true,api:'openai-completions',input:['text','image'],
 thinkingLevels:['off','low','high'],thinkingLevelMap:{off:'disabled',low:'light',high:'full',max:null},
 promptCache:{short:300,long:3600},narrativeCompatible:true,supportsMidConversationSystemMessages:true,...overrides,
});
const catalog=()=>[
 {providerId:'one',name:'Provider One',models:[model('one')]},
 {providerId:'two',name:'Provider Two',models:[model('two',{contextWindow:32768})]},
];
const saved=()=>({id:'saved',name:'My connection',providerId:'one',modelId:'shared-id',credentialStatus:'configured',createdAt:1,updatedAt:1});

test('provider selection resolves SDK models within the chosen group, including repeated model IDs',()=>{
 const groups=catalog();
 assert.equal(findCatalogModel(groups,'one','shared-id').contextWindow,131072);
 assert.equal(findCatalogModel(groups,'two','shared-id').contextWindow,32768);
 assert.equal(findCatalogModel(groups,'missing','shared-id'),undefined);
 assert.equal(findCatalogModel(groups,'one','missing'),undefined);
});

test('new connections begin without inferred defaults and require a real catalog choice and a key',()=>{
 const draft=modelDraft();
 assert.equal(draft.providerId,'');assert.equal(draft.modelId,'');
 draft.name='My model';
 assert.equal(modelDraftError(draft,catalog()),'请选择服务商和模型。');
 draft.providerId='one';draft.modelId='not-in-sdk';
 assert.equal(modelDraftError(draft,catalog()),'请选择当前服务商下的模型。');
 draft.modelId='shared-id';
 assert.equal(modelDraftError(draft,null),'模型目录尚未读取，请重试后选择模型。');
 assert.equal(modelDraftError(draft,catalog()),'请填写 API Key。');
 draft.apiKey='new key';assert.equal(modelDraftError(draft,catalog()),null);
});

test('switching providers clears the old model and typed key while preserving other edits',()=>{
 const draft=modelDraft(saved());draft.name='Unsaved name';draft.apiKey='old-provider-key';
 const changed=changeProvider(draft,'two');
 assert.equal(changed.name,'Unsaved name');assert.equal(changed.modelId,'');assert.equal(changed.apiKey,'');
 assert.deepEqual(changed.original,{providerId:'one',modelId:'shared-id'});
 assert.equal(draft.modelId,'shared-id');assert.equal(draft.apiKey,'old-provider-key');
 assert.strictEqual(changeProvider(draft,'one'),draft);
 changed.modelId='shared-id';
 assert.equal(modelDraftError(changed,catalog()),'更换服务商后请填写新的 API Key。');
 changed.apiKey='new-provider-key';assert.equal(modelDraftError(changed,catalog()),null);
});

test('editing a saved connection never restores a secret and tolerates unavailable or retired catalog entries',()=>{
 const draft=modelDraft({...saved(),apiKey:'must not be copied'});
 assert.equal(draft.apiKey,'');
 draft.name='Edited while catalog loads';draft.apiKey='replacement';
 assert.equal(keepsSavedSelection(draft),true);
 assert.equal(modelDraftError(draft,null),null);
 assert.equal(modelDraftError(draft,[]),null);
 const found=findCatalogModel(catalog(),draft.providerId,draft.modelId);
 assert.equal(found.name,'SDK model');assert.equal(draft.name,'Edited while catalog loads');assert.equal(draft.apiKey,'replacement');
 draft.modelId='different';
 assert.equal(keepsSavedSelection(draft),false);
 assert.equal(modelDraftError(draft,[]),'请选择当前服务商下的模型。');
});

test('metadata displays raw SDK limits and explicit mappings without inferring supported thinking levels',()=>{
 const facts=Object.fromEntries(modelFacts(model('one')).map(fact=>[fact.field,fact]));
 assert.equal(facts.contextWindow.value,'131,072 tokens');
 assert.equal(facts.maxTokens.value,'8,192 tokens');
 assert.equal(facts.reasoning.value,'支持');
 assert.equal(facts.api.value,'openai-completions');assert.equal(facts.input.value,'文本 · 图片');
 assert.equal(facts.promptCache.value,'短 5 分钟 · 长 1 小时');
 assert.equal(facts.promptCache.label,'提示词缓存');assert.equal(facts.promptCache.detail,'目录参考保留时长');
 assert.equal(facts.thinkingLevelMap.value,'off → disabled · low → light · high → full · max → 不支持');
 assert.equal(facts.thinkingLevelMap.detail,'可用档位：off / low / high');
 assert.ok(!facts.thinkingLevelMap.detail.includes('medium'));
});

test('missing SDK metadata remains unknown and off alone does not imply reasoning support',()=>{
 const facts=Object.fromEntries(modelFacts(model('one',{
  reasoning:false,thinkingLevels:['off'],thinkingLevelMap:null,promptCache:null,
 })).map(fact=>[fact.field,fact]));
 assert.equal(facts.reasoning.value,'不支持');
 assert.equal(facts.thinkingLevelMap.value,'未提供映射');
 assert.equal(facts.thinkingLevelMap.detail,'可用档位：off');
 assert.equal(facts.promptCache.value,'未提供');assert.equal(facts.promptCache.detail,undefined);
 const partial=Object.fromEntries(modelFacts(model('one',{promptCache:{short:300,long:null}})).map(fact=>[fact.field,fact]));
 assert.equal(partial.promptCache.value,'短 5 分钟 · 长 未提供');
});

test('cache durations preserve seconds and distinguish zero, missing and invalid values',()=>{
 assert.equal(cacheDuration(0),'0 秒');assert.equal(cacheDuration(90),'90 秒');
 assert.equal(cacheDuration(86400),'1 天');assert.equal(cacheDuration(1.5),'1.5 秒');
 for(const value of [null,undefined,-1,NaN,Infinity])assert.equal(cacheDuration(value),'未提供');
});
