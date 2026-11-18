import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveTheme,builtinTheme,applyTheme,applyAppearance,COLOR_TOKENS,STORY_COLOR_MAP} from '../../src/styles/theme.ts';

test('both built-in palettes resolve complete contrast-checked contracts',()=>{
 for(const mode of ['light','dark']){const theme=resolveTheme(builtinTheme(mode));assert.equal(theme.mode,mode);assert.equal(Object.keys(theme.colors).length,COLOR_TOKENS.length);}
 assert.equal(STORY_COLOR_MAP.line,'reading-border');
});
test('base color changes derive actions, selections and reading surfaces',()=>{
 const original=resolveTheme(builtinTheme('light'));
 const changed=resolveTheme({...builtinTheme('light'),colors:{accent:'#325fa5',canvas:'#f9fafb'}});
 assert.equal(changed.colors['action-primary-bg'],'#325fa5');
 assert.equal(changed.colors['reading-bg'],'#f9fafb');
 assert.notEqual(changed.colors['selection-bg'],original.colors['selection-bg']);
 const explicit=resolveTheme({...builtinTheme('light'),colors:{accent:'#325fa5','selection-bg':'#eeeeee'}});
 assert.equal(explicit.colors['selection-bg'],'#eeeeee');
});
test('invalid payloads and insufficient contrast are rejected',()=>{
 for(const value of [null,[],{...builtinTheme('light'),version:2},{...builtinTheme('light'),css:'body{}'},
 {...builtinTheme('light'),colors:{unknown:'#fff'}},{...builtinTheme('light'),colors:{accent:'url(https://example.invalid)'}},
 {...builtinTheme('light'),colors:{text:'#f5f3f7'}},{...builtinTheme('light'),colors:{canvas:'rgba(255,255,255,.2)'}}])assert.throws(()=>resolveTheme(value));
});
test('failed themes and incomplete appearance messages cannot partially update DOM',()=>{
 const writes=new Map();const root={style:{setProperty:(key,value)=>writes.set(key,value)},dataset:{},dispatchEvent:()=>{}};
 applyTheme(builtinTheme('dark'),root);const before=Array.from(writes);
 assert.throws(()=>applyTheme({...builtinTheme('light'),colors:{text:'#f5f3f7'}},root));assert.deepEqual(Array.from(writes),before);
 const previous=globalThis.document;globalThis.document={documentElement:root};
 try{
  assert.equal(applyAppearance({version:1,mode:'light',colors:{'--canvas':'#fff'}}),false);assert.deepEqual(Array.from(writes),before);
  const theme=resolveTheme(builtinTheme('light'));const colors=Object.fromEntries(Object.entries(theme.colors).map(([key,value])=>['--'+key,value]));
  assert.equal(applyAppearance({version:1,mode:'light',colors}),true);assert.equal(root.dataset.theme,'light');assert.equal(writes.get('--reading-border'),theme.colors['reading-border']);
  assert.equal(applyAppearance({version:1,mode:'dark',colors:{...colors,'--canvas':'red;position:fixed'}}),false);assert.equal(root.dataset.theme,'light');
 }finally{globalThis.document=previous;}
});
