import { expect,it } from 'vitest';
import { ExtensionStreamSplitter,MAX_TAIL_BYTES } from '../src/runtime/postprocess/stream-splitter.js';
import { parseExtensions } from '../src/runtime/postprocess/parser.js';
import { initialExtensions } from '../src/runtime/postprocess/contracts.js';
import { handleStateUpdate } from '../src/runtime/postprocess/state-update.js';
import { handleActionSuggestions } from '../src/runtime/postprocess/action-suggestions.js';
import {parseStrictJson} from '../src/runtime/postprocess/strict-json.js';
const plan={presetHash:'hash',state_update:{enabled:true,required:true,roots:['score']},action_suggestions:{enabled:true}};
import { tail } from './fixtures/runtime-v2.js';

it('hides every possible tail boundary and preserves Chinese/emoji over arbitrary UTF16 chunks',()=>{
  const body='你好😀，门外有人。\n',extension=tail([{path:'score',value:1,reason:'字面 </state_update> 与  是 JSON 字符串'}]);
  const raw=body+extension;
  for(let cut=0;cut<=raw.length;cut++){
    const split=new ExtensionStreamSplitter();
    const visible=split.push(raw.slice(0,cut))+split.push(raw.slice(cut))+split.finish();
    expect(visible).toBe(body);expect(split.tail).toBe(extension);expect(parseExtensions(split.tail).error).toBeUndefined();
  }
  const split=new ExtensionStreamSplitter();let visible='';
  for(let i=0;i<raw.length;i++)visible+=split.push(raw[i]!);
  expect(visible+split.finish()).toBe(body);
});
it('permanently hides overflow and ambiguous marker suffixes',()=>{
  const split=new ExtensionStreamSplitter();
  expect(split.push('story<sr_')).toBe('story');expect(split.finish()).toBe('');expect(split.incompletePrefix).toBe(true);
  const large=new ExtensionStreamSplitter();expect(large.push('story<state_update>'+ '中'.repeat(MAX_TAIL_BYTES))).toBe('story');
  expect(large.overflow).toBe(true);expect(large.tail).toBeUndefined();expect(large.push('hidden forever')).toBe('');
});
it.each([
  '<action_suggestions>[]</action_suggestions><state_update>[]</state_update>',
  '<other>[]</other>',
  '<state_update>[</state_update>',
  '<state_update>["unterminated]</state_update>',
  '<state_update>[]</state_update>visible',
  '<state_update>[]</state_update><state_update>[]</state_update>',
])('rejects untrustworthy envelope framing: %s',raw=>expect(parseExtensions(raw).error).toBe('EXTENSION_PROTOCOL_INVALID'));
it('isolates framed invalid/duplicate child payloads without invalidating the other child',()=>{
  const parsed=parseExtensions('<state_update>[{"path":"score","path":"other","value":1}]</state_update><action_suggestions>["a"]</action_suggestions>');
  expect(parsed.state_update?.error).toBe('STATE_UPDATE_INVALID');expect(parsed.action_suggestions?.value).toEqual(['a']);expect(parsed.error).toBeUndefined();
  const duplicate=parseExtensions('<state_update>[]</state_update><state_update>[]</state_update><action_suggestions>["a"]</action_suggestions>');
  expect(duplicate.error).toBe('EXTENSION_PROTOCOL_INVALID');
});
it.each(['{"a":1,"\\u0061":2}','[1,]','{"x":1,}','NaN','01','[true false]','1e999','\u00a0[]', '['.repeat(34)+'0'+']'.repeat(34)])('uses strict JSON: %s',raw=>expect(()=>parseStrictJson(raw)).toThrow());
it('applies valid items in order, enforces permissions, and blocks suggestions after partial state',()=>{
  const initial=initialExtensions(plan);
  const result=handleStateUpdate({value:[{path:'score',value:1},{path:'hidden',value:2},{path:'score',value:3,reason:'😀'.repeat(140)}]},
    initial.stateUpdate,{score:0},{score:{type:'number',initial:0,min:0}},new Set(['score']));
  expect(result.workspace).toEqual({score:3});
  expect(result.result).toMatchObject({status:'partial'});
  expect(handleActionSuggestions({value:['go']},initial.actionSuggestions,result.result)).toMatchObject({status:'blocked',items:[]});
});
it('accepts empty changes and suggestions, deduplicates and ignores disabled child values',()=>{
  const active=new Set(['score']),initial=initialExtensions(plan);
  const state=handleStateUpdate({value:[]},initial.stateUpdate,{score:0},{score:{type:'number',initial:0}},active);
  expect(state.result.status).toBe('unchanged');
  expect(handleActionSuggestions({value:[' a ','a','b']},initial.actionSuggestions,state.result)).toMatchObject({status:'failed',items:[]});
  expect(handleActionSuggestions({value:[]},initial.actionSuggestions,state.result).status).toBe('failed');
  const disabled=initialExtensions({...plan,state_update:{...plan.state_update,enabled:false}});
  expect(handleStateUpdate({error:'STATE_UPDATE_INVALID'},disabled.stateUpdate,{score:0},{},active)).toMatchObject({workspace:{score:0},result:{status:'disabled'}});
});
