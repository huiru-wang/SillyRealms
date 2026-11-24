import {isSafeStateKey,STATE_MAX_DEPTH} from '@sillyrealms/sdk/state-validation';
import type {StateScope,StateValue} from '../../../../../packages/sr-sdk/src/stage-contract.js';

export type StateObject=Record<string,StateValue>;
export const stateScopes:readonly StateScope[]=['global','session','message'];
export function isStateScope(value:unknown):value is StateScope{return stateScopes.some(scope=>scope===value);}
export function isStateObject(value:unknown):value is Record<string,unknown>{
  return value!==null&&typeof value==='object'&&!Array.isArray(value)&&
    (Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
}
export function isStateValue(value:unknown,depth=0,parents=new Set<object>()):value is StateValue {
  if(depth>STATE_MAX_DEPTH)return false;
  if(value===null||typeof value==='string'||typeof value==='boolean')return true;
  if(typeof value==='number')return Number.isFinite(value);
  if(typeof value!=='object'||parents.has(value)||(!Array.isArray(value)&&!isStateObject(value)))return false;
  parents.add(value);
  const valid=Array.isArray(value)?value.every(item=>isStateValue(item,depth+1,parents)):
    Object.entries(value).every(([key,item])=>isSafeStateKey(key)&&isStateValue(item,depth+1,parents));
  parents.delete(value);return valid;
}
export function isStatePath(path:unknown):path is string {
  return typeof path==='string'&&path.length>0&&path.split('.').every(isSafeStateKey);
}
export function objectValues(value:unknown):StateObject {
  if(!isStateObject(value)||!isStateValue(value))throw Error("sessions:invalidStateResponse");
  return structuredClone(value) as StateObject;
}
/** Server resolves inheritance before returning message entries; null means no inherited roots. */
export function messageValues(value:unknown):StateObject {
  if(value===null)return {};
  if(!Array.isArray(value))throw Error("sessions:invalidMessageState");
  const result:StateObject={};
  for(const entry of value){
    if(!isStateObject(entry)||typeof entry.key!=='string'||!isSafeStateKey(entry.key)||
      !Object.hasOwn(entry,'value')||!isStateValue(entry.value)||Object.hasOwn(result,entry.key))
      throw Error("sessions:invalidMessageState");
    result[entry.key]=structuredClone(entry.value);
  }
  return result;
}
/** Events are authoritative values. A missing parent needs a fresh scope snapshot. */
export function applyStateChange(current:StateObject,path:string,value:StateValue):StateObject|null {
  if(path==='')return objectValues(value);
  if(!isStatePath(path)||!isStateValue(value))return null;
  const result=structuredClone(current),parts=path.split('.');
  let parent=result;
  for(const part of parts.slice(0,-1)){
    const child=parent[part];
    if(!isStateObject(child))return null;
    parent=child as StateObject;
  }
  parent[parts[parts.length-1]!]=structuredClone(value);
  return result;
}
