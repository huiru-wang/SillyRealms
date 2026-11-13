import {mockWorlds,defaultRoleNames,categories} from '../../../fixtures/worlds';
import {sessionSamples} from '../../../fixtures/sessions';

export type Page<T>={items:T[];hasMore:boolean;nextCursor:string|null};
export type Tag={id:string;name:string};
export type WorldListItem={id:string;name:string;cover:string|null;tags:Tag[];sessionCount:number};
export type Character={id:string;name:string;description?:string;avatar?:string};
export type Opening={id:string;name:string;content:string;initial_state?:Record<string,unknown>};
export type StateDefinition={type:string;description?:string;initial:unknown;min?:number;max?:number};
export type WorldData={name:string;summary?:string;description?:string;cover?:string;tags?:string[];characters:Character[];openings:Opening[];lorebook?:{entries:{id:string;title?:string;content:string}[]};state?:{scopes?:Record<string,Record<string,StateDefinition>>}};
export type WorldDetail={id:string;data:WorldData;defaultPresetId:string|null;defaultApiModelConfigId:string|null};
export type Session={id:string;title:string|null;updatedAt:number;cover:string|null};
export class ApiError extends Error { constructor(readonly code:string, message:string){super(message);} }
async function get<T>(path:string,signal:AbortSignal):Promise<T>{
  const response=await fetch('/api/v1/'+path,{signal});
  let body:unknown;
  try {body=await response.json();} catch {throw new ApiError('INVALID_RESPONSE','服务端返回了无法识别的数据');}
  if(!body||typeof body!=='object'||!('success' in body)||!('data' in body))throw new ApiError('INVALID_RESPONSE','服务端返回了无法识别的数据');
  const envelope=body as {success:boolean;data:T;errorCode?:string;errorMessage?:string};
  if(!response.ok||envelope.success!==true)throw new ApiError(envelope.errorCode||'REQUEST_FAILED',envelope.errorMessage||'请求失败');
  return envelope.data;
}
export function listWorlds(tagId:string, cursor:string|null,signal:AbortSignal){
  if(import.meta.env.VITE_STUDIO_MOCK_DATA==='1'){
    if(signal.aborted)return Promise.reject(new DOMException('Aborted','AbortError'));
    const items=mockWorlds.filter(world=>!tagId||world.categories.includes(tagId as typeof categories[number])).map(world=>({id:world.id,name:world.title,cover:world.cover,tags:world.categories.map(name=>({id:name,name})),sessionCount:sessionSamples.filter(session=>session.worldId===world.id).length}));
    return Promise.resolve({items:cursor?[]:items,hasMore:false,nextCursor:null});
  }
  const query=new URLSearchParams({limit:'24'});if(tagId)query.set('tagId',tagId);if(cursor)query.set('cursor',cursor);
  return get<Page<WorldListItem>>('worlds?'+query,signal).then(checkPage);
}
function checkPage<T>(page:Page<T>):Page<T>{
  if(!page||!Array.isArray(page.items)||typeof page.hasMore!=='boolean'||!(page.nextCursor===null||typeof page.nextCursor==='string'))throw new ApiError('INVALID_RESPONSE','服务端返回了无法识别的数据');
  return page;
}
export function listTags(signal:AbortSignal){if(import.meta.env.VITE_STUDIO_MOCK_DATA==='1')return Promise.resolve({items:categories.map(name=>({id:name,name}))});return get<{items:Tag[]}>('tags?type=world',signal).then(data=>{if(!data||!Array.isArray(data.items))throw new ApiError('INVALID_RESPONSE','服务端返回了无法识别的数据');return data;});}
export function getWorld(id:string,signal:AbortSignal){
  if(import.meta.env.VITE_STUDIO_MOCK_DATA==='1'){
    const world=mockWorlds.find(item=>item.id===id);
    if(!world)return Promise.reject(new ApiError('WORLD_NOT_FOUND','世界卡不存在'));
    return Promise.resolve({item:{id:world.id,data:{name:world.title,summary:world.description,description:world.description,cover:world.cover,tags:world.categories,characters:(world.roleNames??defaultRoleNames).map((name,i)=>({id:String(i),name})),openings:[{id:'opening',name:'故事开始',content:'一段新的故事，即将展开。'}]},defaultPresetId:null,defaultApiModelConfigId:null},warnings:[]});
  }
  return get<{item:WorldDetail;warnings:unknown[]}>('worlds/'+encodeURIComponent(id),signal).then(data=>{if(!data?.item?.data||!Array.isArray(data.item.data.characters)||!Array.isArray(data.item.data.openings))throw new ApiError('INVALID_RESPONSE','服务端返回了无法识别的数据');return data;});
}
export function listSessions(id:string,cursor:string|null,signal:AbortSignal){
  if(import.meta.env.VITE_STUDIO_MOCK_DATA==='1')return Promise.resolve({items:cursor?[]:sessionSamples.filter(session=>session.worldId===id).map((session,index)=>({id:session.id,title:session.title,updatedAt:Date.UTC(2026,0,20-index),cover:session.cover})),hasMore:false,nextCursor:null});
  const query=new URLSearchParams({worldId:id,limit:'20'});if(cursor)query.set('cursor',cursor);
  return get<Page<Session>>('sessions?'+query,signal).then(checkPage);
}
export function safeImage(value:string|null|undefined):string|undefined{
  if(!value)return undefined;
  if(/^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i.test(value))return value;
  try {const url=new URL(value,location.origin);return ['http:','https:'].includes(url.protocol)?url.href:undefined;} catch{return undefined;}
}
