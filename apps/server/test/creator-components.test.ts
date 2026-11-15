import {expect,it} from 'vitest';
import {parseCard} from '../src/domain/world-card.js';
import {readFileSync} from 'node:fs';
import {inspectModule,moduleGraph} from '../../../packages/sr-ui-compiler/src/modules.js';
import {createModuleLoader} from '../../../packages/sr-ui-compiler/src/loader.js';
const base=JSON.parse(readFileSync(new URL('./fixtures/world-card.json',import.meta.url),'utf8'));
const card=(value:any)=>({...base,data:{...base.data,description:undefined,components:value.source,stage_component:value.main}});
it('accepts a component library without a stage and a missing main target',()=>{
 for(const main of [undefined,'missing'])expect(parseCard(card({source:[{id:'StatusBar',component:'export default function StatusBar(){return null}'}],main})).data.components).toHaveLength(1);
 expect(()=>parseCard({...base,data:{...base.data,ui:{source:[]}}})).toThrow();
 expect(()=>parseCard(card({source:[{id:'same',component:'x'},{id:'same',component:'y'}]}))).toThrow('Duplicate ID');
});
it('allows only the new SDK name and exact local default imports',()=>{
 expect(inspectModule("import {SR} from '@sillyrealms/sdk'; import Status from './Status'; export default function Main(){return <Status/>}",new Set(['Status']))).toEqual(['Status']);
 for(const source of ["import {SR} from '@sr/sdk'; export default ()=>null", "import x from 'https://example.com/a'; export default x", "import x from './missing';export default x", "export default ()=>import('./Status')", "export default ()=>require('react')", "import {x} from './Status';export default x"])
  expect(()=>inspectModule(source,new Set(['Status']))).toThrow();
 expect(()=>moduleGraph([{id:'A',component:"import B from './B'; export default B"},{id:'B',component:"import A from './A';export default A"}])).toThrow('循环');
});
it('caches shared modules, rejects cycles, and isolates failed modules',()=>{
 let evaluations=0;
 const code={Shared:"module.exports.default=function Shared(){}",Main:"module.exports.default=require('./Shared').default",Bad:"throw Error('broken')",Cycle:"module.exports.default=require('./Cycle').default"};
 const load=createModuleLoader(code,{}, {},(source,module,require)=>{evaluations++;new Function('module','require',source)(module,require);});
 expect(load('Main')).toBe(load('Shared'));expect(evaluations).toBe(2);
 expect(()=>load('Bad')).toThrow('broken');expect(load('Main')).toBe(load('Shared'));
 expect(()=>load('Cycle')).toThrow('循环');expect(()=>load('Missing')).toThrow('不存在');
});
it('keeps old SDK resolution unavailable even to emitted code',()=>{
 const load=createModuleLoader({Main:"module.exports.default=require('@sr/sdk')"},{},{'@sillyrealms/sdk':{}},(source,module,require)=>new Function('module','require',source)(module,require));
 expect(()=>load('Main')).toThrow('禁止的依赖');
});

it('converts legacy message libraries without duplicating their shared closure',async()=>{
 const {convertLegacyUI}=await import('../../../packages/sr-ui-compiler/src/convert-legacy.js');
 const old={rules:[{replacement:{type:'component',component:'Choice'}}],component_source:"import React from 'react';import {SR} from '@sr/sdk';let count=0;function Choice(){return ++count} export default {Choice};"};
 const result=convertLegacyUI({type:'react',source:"import {SR} from '@sr/sdk';export default function Main(){return null}"},old);
 expect(result.changed).toBe(true);expect(result.ui.main).toBe('Main');expect(result.messageRender.component_source).toBeUndefined();
 expect(result.ui.source.map((item:any)=>item.component).join('\n')).not.toContain('@sr/sdk');
 expect(result.ui.source.find((item:any)=>item.id==='Choice').component).toContain("import Library from './MessageLibrary'");
 expect(moduleGraph(result.ui.source).size).toBe(3);expect(convertLegacyUI(result.ui,result.messageRender).changed).toBe(false);
 expect(old.component_source).toContain('@sr/sdk');
});
