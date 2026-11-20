import {resolveSRAssetUrl} from '@sillyrealms/sdk/assets';

export function worldAssetBaseUrl(origin:string|null|undefined,worldId:string|null|undefined):string|null {
 return origin&&worldId?new URL('/api/v1/worlds/'+encodeURIComponent(worldId)+'/resources/',origin).href:null;
}
export function safeImage(value:string|null|undefined,assetBaseUrl?:string|null):string|undefined {
 if(!value)return undefined;
 if(value.startsWith('sr-asset:')){
  if(!assetBaseUrl)return undefined;
  try{return resolveSRAssetUrl(value,assetBaseUrl)??undefined;}catch{return undefined;}
 }
 if(/^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i.test(value))return value;
 try{return resolveSRAssetUrl(value,assetBaseUrl)??undefined;}catch{return undefined;}
}
