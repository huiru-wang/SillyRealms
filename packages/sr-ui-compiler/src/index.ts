import * as esbuild from 'esbuild-wasm';
import wasm from 'esbuild-wasm/esbuild.wasm?url';
import {inspectModule, type ComponentSource} from './modules';
export {inspectModule, moduleGraph} from './modules';
export type {ComponentSource} from './modules';
let init:Promise<void>|undefined;
export async function compile(source:string, ids:ReadonlySet<string>=new Set()) {
  inspectModule(source,ids);
  init??=esbuild.initialize({wasmURL:wasm,worker:true});
  await init;
  return (await esbuild.transform(source,{loader:'tsx',format:'cjs',jsx:'transform',target:'es2022'})).code;
}
export type CompiledComponents={code:Record<string,string>;errors:Record<string,string>};
/** An unused or message-only module must not break the stage. */
export async function compileComponents(sources:ComponentSource[]):Promise<CompiledComponents> {
  const ids=new Set(sources.map(item=>item.id));
  if(ids.size!==sources.length)throw Error('组件 ID 重复');
  const code:Record<string,string>=Object.create(null),errors:Record<string,string>=Object.create(null);
  for(const item of sources){
    try {code[item.id]=await compile(item.component,ids);}
    catch(error){errors[item.id]=error instanceof Error?error.message:'组件编译失败';}
  }
  return {code,errors};
}
