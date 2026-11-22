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
test('thinking depth round-trips all standard choices and stays optional for existing presets',()=>{
 const legacy=fromServer(detail());
 assert.equal(Object.hasOwn(presetInput(legacy).config.modelParameters,'thinkingLevel'),false);
 for(const level of ['minimal','low','medium','high','xhigh','max']){
  const saved=detail();saved.config.modelParameters={thinkingEnabled:true,thinkingLevel:level};
  const draft=fromServer(saved);
  assert.equal(getPresetValidationError(draft),null);
  assert.equal(presetInput(draft).config.modelParameters.thinkingLevel,level);
  draft.thinkingEnabled=false;
  assert.deepEqual(presetInput(draft).config.modelParameters,{thinkingEnabled:false,thinkingLevel:level});
 }
 legacy.thinkingLevel='ultra';
 assert.equal(getPresetValidationError(legacy),'请选择有效的思考深度。');
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

test('range edits preserve exact values, explicit zero and missing fields through save and copy', () => {
 const draft = fromServer(detail());
 Object.assign(draft, { temperature: '0.735', topP: '1', frequencyPenalty: '-2', presencePenalty: 0 });
 assert.equal(getPresetValidationError(draft), null);
 assert.deepEqual(presetInput(draft).config.modelParameters, {
   thinkingEnabled: false, temperature: 0.735, topP: 1, frequencyPenalty: -2, presencePenalty: 0,
 });
 for (const incomplete of ['', '-', '3', '0x1', 'Infinity']) {
   draft.frequencyPenalty = incomplete;
   assert.match(getPresetValidationError(draft), /频率惩罚/);
   assert.throws(() => presetInput(draft));
 }
 draft.frequencyPenalty = undefined;
 assert.equal(getPresetValidationError(draft), null);
 assert.equal(Object.hasOwn(presetInput(draft).config.modelParameters, 'frequencyPenalty'), false);
});
