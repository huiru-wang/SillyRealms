import type {StateScope} from '../../../../../packages/sr-sdk/src/stage-contract.js';
import {isSafeStateKey} from '@sillyrealms/sdk/state-validation';

export type StateManifest={scopes:Partial<Record<StateScope,Record<string,true>>>};
/** The stage receives declared root names, without author rules or private initial values. */
export function stateManifest(state:unknown):StateManifest {
  const result:StateManifest={scopes:{}};
  if(!state||typeof state!=='object'||!('scopes' in state))return result;
  const scopes=state.scopes;
  if(!scopes||typeof scopes!=='object'||Array.isArray(scopes))return result;
  for(const scope of ['global','session','message'] as const){
    const definitions=(scopes as Record<string,unknown>)[scope];
    if(definitions&&typeof definitions==='object'&&!Array.isArray(definitions))
      result.scopes[scope]=Object.fromEntries(Object.keys(definitions).filter(isSafeStateKey).map(name=>[name,true as const]));
  }
  return result;
}
