import type {ComponentSource} from '../../../../../packages/sr-ui-compiler/src/modules.js';

type CompiledPreview={code:Record<string,string>;errors:Record<string,string>};

/** Detail previews only. Cache compiled code, never component instances or state. */
export function createPreviewCompiler(compile:(sources:ComponentSource[])=>Promise<CompiledPreview>) {
  const cache=new Map<string,{source:string;result:Promise<CompiledPreview>}>();
  return (worldId:string,sources:ComponentSource[]):Promise<CompiledPreview>=>{
    // Snapshot before compilation awaits; source changes invalidate even reused arrays.
    const snapshot=sources.map(({id,component})=>({id,component})),source=JSON.stringify(snapshot);
    const existing=cache.get(worldId);
    if(existing?.source===source){cache.delete(worldId);cache.set(worldId,existing);return existing.result;}
    const result=Promise.resolve().then(()=>compile(snapshot));
    const entry={source,result};
    cache.delete(worldId);cache.set(worldId,entry);
    // Bound retention across navigation. Reloading the app clears this memory cache.
    if(cache.size>4)cache.delete(cache.keys().next().value!);
    const forget=()=>{if(cache.get(worldId)===entry)cache.delete(worldId);};
    void result.then(value=>{if(Object.keys(value.errors).length)forget();},forget);
    return result;
  };
}
