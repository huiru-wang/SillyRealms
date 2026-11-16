import {afterEach,expect,it,vi} from 'vitest';
import {compileWorldComponents} from '../../studio/src/features/worlds/compile-world-components.js';
import {createPreviewCompiler} from '../../studio/src/features/worlds/preview-compilation-cache.js';
import {inspectModule} from '../../../packages/sr-ui-compiler/src/modules.js';
import {createModuleLoader} from '../../../packages/sr-ui-compiler/src/loader.js';
import type {WorldDetail} from '../../studio/src/features/worlds/api/worlds.js';

const world:WorldDetail={
  id:'world-a',defaultPresetId:null,defaultApiModelConfigId:null,
  data:{name:'Offline',characters:[],openings:[],components:[
    {id:'Main',path:'sr-asset://components/stage/Main.tsx',component:'INLINE FALLBACK MUST NOT EXECUTE'},
    {id:'CG',path:'sr-asset://components/shared/CG.tsx',component:'ANOTHER UNUSED FALLBACK'},
  ],stage_component:'Main'},
};
function response(data:unknown){return Response.json({success:true,errorCode:null,errorMessage:'',data});}
afterEach(()=>vi.unstubAllGlobals());

it('uses resolved file source, preserves failed dependency IDs and exposes its file error without inline fallback',async()=>{
  const main="import CG from './CG'; export default function Main(){ return <CG/>; }";
  const reason='组件 CG 读取失败：components/shared/CG.tsx（文件不存在）';
  const fetch=vi.fn(async()=>response({items:[{id:'Main',component:main}],errors:{CG:reason}}));
  vi.stubGlobal('fetch',fetch);
  const compile=vi.fn(async(sources:Array<{id:string;component:string}>)=>{
    expect(sources.find(item=>item.id==='Main')?.component).toBe(main);
    expect(JSON.stringify(sources)).not.toContain('FALLBACK');
    expect(inspectModule(main,new Set(sources.map(item=>item.id)))).toEqual(['CG']);
    return {code:{Main:'compiled-main'},errors:{CG:'placeholder compile error'}};
  });
  const compiled=await compileWorldComponents(world,compile);
  expect(fetch).toHaveBeenCalledWith('/api/v1/worlds/world-a/components',expect.objectContaining({signal:undefined}));
  expect(compiled.errors.CG).toBe(reason);
  const load=createModuleLoader(compiled.code,compiled.errors,{},(_source,module,require)=>{
    module.exports.default=(require('./CG') as {default:unknown}).default;
  });
  expect(()=>load('Main')).toThrow('components/shared/CG.tsx');
  expect(world.data.components?.[0]?.component).toBe('INLINE FALLBACK MUST NOT EXECUTE');
});

it('invalidates preview compilation when a file changes at the same path and world ID',async()=>{
  let source='export default function Main(){ return <p>first</p>; }';
  vi.stubGlobal('fetch',vi.fn(async()=>response({items:[{id:'Main',component:source}],errors:{}})));
  const compile=vi.fn(async(items:Array<{id:string;component:string}>)=>({code:{Main:items[0]!.component},errors:{}}));
  const preview=createPreviewCompiler(compile);
  const run=()=>compileWorldComponents(world,items=>preview(world.id,items));
  const first=await run();
  expect((await run()).code.Main).toBe(first.code.Main);
  expect(compile).toHaveBeenCalledTimes(1);
  source='export default function Main(){ return <p>updated</p>; }';
  expect((await run()).code.Main).toContain('updated');
  expect(compile).toHaveBeenCalledTimes(2);
});

it('adds manifest file locations to compiler errors without mutating a cached compilation result',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>response({items:[{id:'Main',component:'broken'}],errors:{}})));
  const cached={code:{},errors:{Main:'Unexpected token'}};
  const actual=await compileWorldComponents(world,async()=>cached);
  expect(actual.errors.Main).toContain('sr-asset://components/stage/Main.tsx');
  expect(actual.errors.Main).toContain('Unexpected token');
  expect(cached.errors.Main).toBe('Unexpected token');
});

it('discards a compilation that finishes after its view has been closed',async()=>{
  const abort=new AbortController();
  vi.stubGlobal('fetch',vi.fn(async()=>response({items:[],errors:{}})));
  await expect(compileWorldComponents(world,async()=>{
    abort.abort();
    return {code:{},errors:{}};
  },abort.signal)).rejects.toMatchObject({name:'AbortError'});
});
