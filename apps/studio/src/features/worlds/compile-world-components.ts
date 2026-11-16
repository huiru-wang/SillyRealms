import type {ComponentSource} from '../../../../../packages/sr-ui-compiler/src/modules.js';
import {api,ApiError} from '../../api.js';
import type {WorldDetail} from './api/worlds.js';

type CompiledComponents={code:Record<string,string>;errors:Record<string,string>};
type ResolvedComponents={items:ComponentSource[];errors:Record<string,string>};

/** Keep manifest definitions separate from runtime source. Missing files never select inline fallback. */
export async function compileWorldComponents(
  world:WorldDetail,
  compile:(sources:ComponentSource[])=>Promise<CompiledComponents>,
  signal?:AbortSignal,
):Promise<CompiledComponents> {
  const resolved=await api<ResolvedComponents>('v1/worlds/'+encodeURIComponent(world.id)+'/components',{signal});
  signal?.throwIfAborted();
  if(!resolved||!Array.isArray(resolved.items)||!resolved.errors||typeof resolved.errors!=='object'||
     resolved.items.some(item=>!item||typeof item.id!=='string'||typeof item.component!=='string')||
     Object.values(resolved.errors).some(value=>typeof value!=='string'))throw new ApiError('INVALID_RESPONSE','组件源码响应格式无效');
  // Failed modules still belong to the ID graph, so dependants can report their original file error.
  const ids=new Set(resolved.items.map(item=>item.id));
  const sources=[...resolved.items,...Object.keys(resolved.errors).filter(id=>!ids.has(id)).map(id=>({id,component:''}))];
  const compiled=await compile(sources);
  signal?.throwIfAborted();
  const definitions=new Map((world.data.components??[]).map(item=>[item.id,item]));
  const errors:Record<string,string>=Object.create(null);
  for(const [id,reason] of Object.entries(compiled.errors)){
    const path=definitions.get(id)?.path;
    errors[id]='组件 '+id+(path?'（'+path+'）':'')+'：'+reason;
  }
  Object.assign(errors,resolved.errors);
  return {code:compiled.code,errors};
}
