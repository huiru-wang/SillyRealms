import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fromServer,presetInput,getPresetValidationError} from '../src/features/presets/adapter.ts';

const detail=()=>({
 id:'preset',revision:4,type:'narrative',name:'Story',description:'',createdAt:1,updatedAt:1,
 config:{schemaVersion:1,contextStrategy:{strategy:'sliding_window',maxContextTokens:100,maxOutputTokens:20,summaryPrompt:''},modelParameters:{thinkingEnabled:false},
 nodes:['main','personaInfo','characterInfo','worldInfo','chatHistory','userInput'].map(id=>({id,name:id,kind:'system',role:id==='chatHistory'?'auto':id==='userInput'?'user':'system',enabled:true,prompt:''}))},
});

test('editing does not fill an unspecified temperature or leak revision into editable content',()=>{
 const draft=fromServer(detail());
 draft.name='Changed';const input=presetInput(draft);
 assert.equal(draft.revision,4);assert.equal(input.name,'Changed');
 assert.equal(Object.hasOwn(input.config.modelParameters,'temperature'),false);
 assert.equal(Object.hasOwn(input,'revision'),false);assert.equal(Object.hasOwn(input,'id'),false);
});
test('draft nodes do not mutate a saved server object',()=>{
 const saved=detail(),draft=fromServer(saved);draft.nodes[0].prompt='Changed';
 assert.equal(saved.config.nodes[0].prompt,'');
});
test('summary is required only for rolling summary and zero temperature is retained',()=>{
 const draft=fromServer(detail());assert.equal(getPresetValidationError(draft),null);
 draft.temperature=0;assert.equal(presetInput(draft).config.modelParameters.temperature,0);
 draft.contextStrategy='rolling_summary';assert.equal(getPresetValidationError(draft),'压缩提示词不能为空。');
 draft.summaryPrompt='Summarize';assert.equal(getPresetValidationError(draft),null);
});
