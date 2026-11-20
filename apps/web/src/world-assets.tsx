import {useEffect,useState,type ImgHTMLAttributes,type ReactNode} from 'react';
import {SRAssetProvider} from '@sillyrealms/sdk';
import {safeImage,worldAssetBaseUrl} from './features/worlds/resources';
export {worldAssetBaseUrl} from './features/worlds/resources';
export function useWorldAssetBaseUrl(worldId:string|null|undefined) {return worldAssetBaseUrl(location.origin,worldId);}
export function WorldAssetsProvider({worldId,children}:{worldId:string;children:ReactNode}) {
 return <SRAssetProvider baseUrl={useWorldAssetBaseUrl(worldId)}>{children}</SRAssetProvider>;
}
export function WorldAssetImage({worldId,source,...props}:{worldId?:string|null;source?:string|null}&Omit<ImgHTMLAttributes<HTMLImageElement>,'src'>) {
 const src=safeImage(source,useWorldAssetBaseUrl(worldId)),[failed,setFailed]=useState(false);
 useEffect(()=>setFailed(false),[src]);
 return src&&!failed?<img {...props} src={src} onError={()=>setFailed(true)}/>:null;
}
