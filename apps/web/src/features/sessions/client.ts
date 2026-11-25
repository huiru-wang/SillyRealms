import {api,json} from '../../api.ts';
import type {Session} from './types.ts';
export type SessionPatch={title?:string|null;runtimeConfig?:Partial<Session['runtimeConfig']>};
export async function readSession(id:string,signal?:AbortSignal):Promise<Session>{
  return (await api<{item:Session}>('v1/sessions/'+encodeURIComponent(id),{signal,cache:'no-store'})).item;
}
export async function updateSession(id:string,patch:SessionPatch,signal?:AbortSignal):Promise<Session>{
  return (await api<{item:Session}>('v1/sessions/'+encodeURIComponent(id),{method:'PATCH',body:json(patch),signal})).item;
}
export type RuntimeConfig={stage:{origin:string;entryPath:'/frame.html'};debug:boolean};
export type SessionCapabilities={characterSprite:{available:boolean}};
export function readRuntimeConfig(sessionId:string,signal?:AbortSignal){
  return api<RuntimeConfig & {capabilities:SessionCapabilities}>('v1/runtime/config?'+new URLSearchParams({sessionId}),{signal,cache:'no-store'});
}
