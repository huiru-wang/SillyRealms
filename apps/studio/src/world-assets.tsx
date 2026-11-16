import {createContext,useContext,useEffect,useState,type ImgHTMLAttributes,type ReactNode} from 'react';
import {SRAssetProvider} from '@sillyrealms/sdk';
import {api} from './api';
import {ErrorNotice} from './app/ui';
import {stageURL} from './stage-url';
import {safeImage} from './features/worlds/api/worlds';

type AssetOrigin={origin:string|null;error:string;retry:()=>void};
const AssetOriginContext=createContext<AssetOrigin>({origin:null,error:'',retry:()=>{}});

/** One trusted configuration load for Studio images; author runtimes receive only their world base URL. */
export function AssetOriginProvider({children}:{children:ReactNode}) {
  const [origin,setOrigin]=useState<string|null>(null),[error,setError]=useState(''),[revision,setRevision]=useState(0);
  useEffect(()=>{
    const abort=new AbortController();
    setError('');
    void api('v1/runtime/web-config',{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10000)])}).then(config=>{
      if(!abort.signal.aborted)setOrigin(stageURL(config,location.origin,'assets').origin);
    }).catch(reason=>{
      if(!abort.signal.aborted)setError(reason instanceof Error?reason.message:'资源服务地址加载失败');
    });
    return()=>abort.abort();
  },[revision]);
  useEffect(()=>{const retry=()=>setRevision(value=>value+1);window.addEventListener('online',retry);return()=>window.removeEventListener('online',retry);},[]);
  return <AssetOriginContext.Provider value={{origin,error,retry:()=>setRevision(value=>value+1)}}>{children}</AssetOriginContext.Provider>;
}

export function worldAssetBaseUrl(origin:string|null|undefined,worldId:string|null|undefined):string|null {
  return origin&&worldId?new URL('/world-assets/'+encodeURIComponent(worldId)+'/',origin).href:null;
}
export function useWorldAssetBaseUrl(worldId:string|null|undefined):string|null {
  return worldAssetBaseUrl(useContext(AssetOriginContext).origin,worldId);
}
export function WorldAssetsProvider({worldId,children}:{worldId:string;children:ReactNode}) {
  const {origin,error,retry}=useContext(AssetOriginContext);
  return <SRAssetProvider baseUrl={worldAssetBaseUrl(origin,worldId)}>
    {error&&<ErrorNotice message={'资源服务连接失败：'+error} onRetry={retry}/>}
    {children}
  </SRAssetProvider>;
}
export function WorldAssetImage({worldId,source,...props}:{worldId?:string|null;source?:string|null}&Omit<ImgHTMLAttributes<HTMLImageElement>,'src'>) {
  const src=safeImage(source,useWorldAssetBaseUrl(worldId));
  return src?<img {...props} src={src}/>:null;
}
