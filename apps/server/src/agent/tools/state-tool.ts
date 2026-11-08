import { ErrorCodes } from '../../common/error-codes.js';
import { updateAtomicState, type AtomicStateDefinition } from '../../domain/state/atomic-state.js';
import type { Json } from '../../domain/state/state.js';

/** The model and creator both use the same validated overwrite semantics. */
export function setState(workspace:Record<string,Json>, fields:Record<string,AtomicStateDefinition>, active:Set<string>, path:string|string[], value:unknown):void {
  const parts=typeof path==='string'?path.split('.'):path;
  if(!parts.length || parts.some(part=>typeof part!=='string' || !part || part.includes('.')))throw new Error(ErrorCodes.INVALID_STATE_PATH);
  if(!active.has(parts[0]!))throw new Error(ErrorCodes.STATE_ROOT_NOT_ACTIVE);
  updateAtomicState(workspace,fields,parts.join('.'),value);
}

export const stateTool={name:'update_state',description:'Overwrite a declared active message state field or JSON object path.',parameters:{type:'object',properties:{path:{anyOf:[{type:'string'},{type:'array',items:{type:'string'}}]},value:{}},required:['path','value'],additionalProperties:false}};

export function stateToolInstructions(fields:Record<string,unknown>,active:Set<string>,render:(text:string)=>string = text=>text,includeFields=true):string {
  const entries=Object.entries(fields).filter(([name])=>active.has(name)).map(([name,raw])=>{
    const def=raw as AtomicStateDefinition;
    return {path:[name],type:def.type,...(def.min!==undefined?{min:def.min}:{}),...(def.max!==undefined?{max:def.max}:{}),...(def.description?{description:render(def.description)}:{})};
  });
  return [
    '状态更新工具使用规则：',
    'global 与 session 状态仅供读取；已激活的 message 状态可通过 update_state 更新。',
    '先完成本轮全部叙事，再依据完整叙事和状态描述检查各项状态；需要更新时调用 update_state，无变化时无需调用。工具调用后不要继续推进叙事。',
    'path 使用状态名及英文句点分隔的字段名；value 为更新后的完整值。更新会覆盖目标，不自动加减或合并；JSON 内路径的父对象须已存在，数组和删除字段时请覆盖整个所属对象。',
    ...(includeFields?['可写字段与描述：',JSON.stringify(entries)]:[]),
  ].join('\n');
}
