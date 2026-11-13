import { expect,it } from 'vitest';
import { ExtensionStreamSplitter,MAX_TAIL_BYTES } from '../src/runtime/narrative/extension-stream-splitter.js';
import { parseExtensions,parseStrictJson } from '../src/runtime/narrative/extension-parser.js';
import { initialExtensions } from '../src/runtime/narrative/extension-contract.js';
import { handleStateUpdate } from '../src/runtime/narrative/state-update-handler.js';
import { handleActionSuggestions } from '../src/runtime/narrative/action-suggestions-handler.js';
import { DEFAULT_CAPABILITIES } from '../src/runtime/config.js';
import { tail } from './fixtures/runtime-v2.js';

it('hides every possible tail boundary and preserves Chinese/emoji over arbitrary UTF16 chunks',()=>{
  const body='你好😀，门外有人。\n',extension=tail([{path:'score',value:1,reason:'字面 </state_update> 与 </sr_extensions> 是 JSON 字符串'}]);
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
  const large=new ExtensionStreamSplitter();expect(large.push('story<sr_extensions>'+ '中'.repeat(MAX_TAIL_BYTES))).toBe('story');
  expect(large.overflow).toBe(true);expect(large.tail).toBeUndefined();expect(large.push('hidden forever')).toBe('');
});
it.each([
  '<sr_extensions><action_suggestions>[]</action_suggestions><state_update>[]</state_update></sr_extensions>',
  '<sr_extensions><other>[]</other></sr_extensions>',
  '<sr_extensions><state_update>[</state_update></sr_extensions>',
  '<sr_extensions><state_update>["unterminated]</state_update></sr_extensions>',
  '<sr_extensions><state_update>[]</state_update></sr_extensions>visible',
  '<sr_extensions><state_update>[]</state_update></sr_extensions><sr_extensions></sr_extensions>',
])('rejects untrustworthy envelope framing: %s',raw=>expect(parseExtensions(raw).error).toBe('EXTENSION_PROTOCOL_INVALID'));
it('isolates framed invalid/duplicate child payloads without invalidating the other child',()=>{
  const parsed=parseExtensions('<sr_extensions><state_update>[{"path":"score","path":"other","value":1}]</state_update><action_suggestions>["a"]</action_suggestions></sr_extensions>');
  expect(parsed.state_update?.error).toBe('STATE_UPDATE_INVALID');expect(parsed.action_suggestions?.value).toEqual(['a']);expect(parsed.error).toBeUndefined();
  const duplicate=parseExtensions('<sr_extensions><state_update>[]</state_update><state_update>[]</state_update><action_suggestions>["a"]</action_suggestions></sr_extensions>');
  expect(duplicate.state_update?.error).toBe('STATE_UPDATE_INVALID');expect(duplicate.action_suggestions?.value).toEqual(['a']);
});
it.each(['{"a":1,"\\u0061":2}','[1,]','{"x":1,}','NaN','01','[true false]','1e999','\u00a0[]', '['.repeat(34)+'0'+']'.repeat(34)])('uses strict JSON: %s',raw=>expect(()=>parseStrictJson(raw)).toThrow());
it('applies valid items in order, enforces permissions, and blocks suggestions after partial state',()=>{
  const initial=initialExtensions({...DEFAULT_CAPABILITIES,action_suggestions:{enabled:true,count:3,prompt:''}},new Set(['score']));
  const result=handleStateUpdate({value:[{path:'score',value:1},{path:'hidden',value:2},{path:'score',value:3,reason:'😀'.repeat(140)}]},
    initial.stateUpdate,{score:0},{score:{type:'number',initial:0,min:0}},new Set(['score']));
  expect(result.workspace).toEqual({score:3});
  expect(result.result).toMatchObject({status:'partial',acceptedCount:2,changedPaths:['score'],skipped:[{index:1,errorCode:'STATE_ROOT_NOT_ACTIVE'}]});
  expect(Array.from(result.diagnostics[0]!.reason)).toHaveLength(120);
  expect(handleActionSuggestions({value:['go']},initial.actionSuggestions,result.result,3)).toMatchObject({status:'blocked',blockedBy:'state_partial',items:[]});
});
it('accepts empty changes and suggestions, deduplicates and ignores disabled child values',()=>{
  const active=new Set(['score']),initial=initialExtensions({...DEFAULT_CAPABILITIES,action_suggestions:{enabled:true,count:3,prompt:''}},active);
  const state=handleStateUpdate({value:[]},initial.stateUpdate,{score:0},{score:{type:'number',initial:0}},active);
  expect(state.result.status).toBe('unchanged');
  expect(handleActionSuggestions({value:[' a ','a','b']},initial.actionSuggestions,state.result,3)).toMatchObject({status:'ready',items:['a','b'],warningCodes:['duplicate_suggestion']});
  expect(handleActionSuggestions({value:[]},initial.actionSuggestions,state.result,3).status).toBe('ready');
  const disabled=initialExtensions({...DEFAULT_CAPABILITIES,state_update:{enabled:false,prompt:''}},active);
  expect(handleStateUpdate({error:'STATE_UPDATE_INVALID'},disabled.stateUpdate,{score:0},{},active)).toMatchObject({workspace:{score:0},result:{status:'disabled'}});
});
