import type {StateScope} from '../../../../../packages/sr-sdk/src/state-contract.js';

export type StateManifest = {scopes:Partial<Record<StateScope,Record<string,true>>>};

/** The stage only needs declared root names; definitions and author rules stay in the host. */
export function stateManifest(state:unknown):StateManifest {
  const result:StateManifest={scopes:{}};
  if(!state||typeof state!=='object'||!('scopes' in state))return result;
  const scopes=(state as {scopes?:unknown}).scopes;
  if(!scopes||typeof scopes!=='object'||Array.isArray(scopes))return result;
  for(const scope of ['global','session','message'] as const){
    const definitions=(scopes as Record<string,unknown>)[scope];
    if(definitions&&typeof definitions==='object'&&!Array.isArray(definitions))
      result.scopes[scope]=Object.fromEntries(Object.keys(definitions).map(name=>[name,true as const]));
  }
  return result;
}
