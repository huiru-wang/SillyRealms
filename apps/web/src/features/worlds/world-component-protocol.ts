import type {StateValue} from '../../../../../packages/sr-sdk/src/state-contract.js';
/** The Host independently checks every request; the iframe SDK is not an authority boundary. */
export function worldStateQueries(method:unknown,data:unknown):Array<{path:string;scope:'global'}> {
  if(method!=='world.state.read')throw Error('API_NOT_ALLOWED');
  const entries=(data as {entries?:unknown})?.entries;
  if(!Array.isArray(entries)||entries.length>100)throw Error('INVALID_STATE_QUERY');
  return entries.map(entry=>{
    if(!entry||typeof entry!=='object'||Object.keys(entry).some(key=>!['path','scope'].includes(key))||entry.scope!==undefined&&entry.scope!=='global')throw Error('STATE_SCOPE_NOT_ALLOWED');
    if(typeof entry.path!=='string'||entry.path.length>2048||entry.path.split('.').length>32||entry.path.split('.').some((part:string)=>!part||['__proto__','prototype','constructor'].includes(part)))throw Error('INVALID_STATE_PATH');
    return {path:entry.path,scope:'global'};
  });
}
export function readWorldState(global:Record<string,StateValue>,path:string):StateValue|undefined {
  let value:StateValue|undefined=global;
  for(const part of path.split('.'))value=value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.hasOwn(value,part)?value[part]:undefined;
  return value;
}
