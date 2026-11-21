import {api,json} from '../../api.ts';
import type {Session} from './types.ts';
export type SessionPatch=Partial<Pick<Session,'title'|'presetId'|'apiModelConfigId'>>;
export async function readSession(id:string,signal?:AbortSignal):Promise<Session>{
  return (await api<{item:Session}>('v1/sessions/'+encodeURIComponent(id),{signal,cache:'no-store'})).item;
}
export async function updateSession(id:string,patch:SessionPatch,signal?:AbortSignal):Promise<Session>{
  return (await api<{item:Session}>('v1/sessions/'+encodeURIComponent(id),{method:'PATCH',body:json(patch),signal})).item;
}
export type RuntimeConfig={stage:{origin:string;entryPath:'/frame.html'};debug:boolean};
export function readRuntimeConfig(signal?:AbortSignal){return api<RuntimeConfig>('v1/runtime/config',{signal,cache:'no-store'});}
