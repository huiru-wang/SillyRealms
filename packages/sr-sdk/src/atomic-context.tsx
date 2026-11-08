import React, {createContext,useContext,useSyncExternalStore} from 'react';
import type { StateScope,StateValue,SRStateAPI } from './state-contract.js';
import type { StateRuntime } from './state-runtime.js';
import type { SRSessionAPI } from './run-contract.js';
import type { SessionRuntime } from './session-runtime.js';

export const AtomicContext=createContext<{session:SessionRuntime;state:StateRuntime}|null>(null);
function useAtomicContext(){const value=useContext(AtomicContext);if(!value)throw new Error('SR provider unavailable');return value;}
export function useSRSession():SRSessionAPI{return useAtomicContext().session;}
export function useSRStateAPI():SRStateAPI{return useAtomicContext().state;}
export function useSRState<T extends StateValue>(path:string,defaultValue:T,options?:{scope?:StateScope}) {
  const state=useAtomicContext().state;const scope=options?.scope??'message';
  const snapshot=useSyncExternalStore(state.observe,state.getSnapshot,state.getSnapshot);
  const value=path.split('.').reduce<StateValue|undefined>((current,part)=>current && typeof current==='object' && !Array.isArray(current)?current[part]:undefined,snapshot[scope]);
  return [value===undefined?defaultValue:value as T,(next:T)=>state.updateState(path,next,scope)] as const;
}
