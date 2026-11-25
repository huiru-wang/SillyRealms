import {createContext,useCallback,useContext,useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {api,json} from '../api';
import {useResource} from '../data';
import {applyLocale} from '../i18n/instance.ts';
import type {AppLocale} from '@sillyrealms/sdk/locale';
import {ErrorNotice,Loading} from './ui';
import {DEFAULT_MOSAIC_DENSITY,MIN_MOSAIC_DENSITY,MAX_MOSAIC_DENSITY} from '../features/worlds/cover-mosaic';

export type AppSettings={defaultReplyAssistPresetId:string|null;defaultPresetId:string|null;defaultApiModelConfigId:string|null;locale:AppLocale;coverMosaicDensity:number};
function useData(){
  const settings=useResource<{item:AppSettings}>('v1/app-settings');
  const [modelsRevision,setModelsRevision]=useState(0),[sessionsRevision,setSessionsRevision]=useState(0);
  const [worldsRevision,setWorldsRevision]=useState(0);
  const [worldCleanup,setWorldCleanup]=useState<{id:string;name:string}[]>([]);
  const [localeSaving,setLocaleSaving]=useState(false);
  const localePending=useRef(false);
  const settingsWrite=useRef<Promise<void>>(Promise.resolve());
  const [mosaicDraft,setMosaicDraft]=useState<number|null>(null);
  const mosaicDraftRef=useRef<number|null>(null);
  const mosaicTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const mosaicPending=useRef<{value:number;promise:Promise<void>}|null>(null);
  const [coverMosaicSaving,setCoverMosaicSaving]=useState(false),[coverMosaicError,setCoverMosaicError]=useState<unknown>(null);
  const refreshWorlds=useCallback(()=>setWorldsRevision(n=>n+1),[]);
  const rememberWorldCleanup=useCallback((item:{id:string;name:string})=>setWorldCleanup(items=>[...items.filter(value=>value.id!==item.id),item]),[]);
  const forgetWorldCleanup=useCallback((id:string)=>setWorldCleanup(items=>items.filter(item=>item.id!==id)),[]);
  const refreshModels=useCallback(()=>setModelsRevision(n=>n+1),[]);
  const refreshSessions=useCallback(()=>setSessionsRevision(n=>n+1),[]);
  const locale=settings.value?.item.locale;
  useLayoutEffect(()=>{if(locale)void applyLocale(locale);},[locale]);
  const saveSettings=useCallback((patch:Partial<AppSettings>)=>{
    // Keep full settings responses in write order while controls save independent fields.
    const request=settingsWrite.current.then(async()=>{
      const result=await api<{item:AppSettings}>('v1/app-settings',{method:'PATCH',body:json(patch)});
      await applyLocale(result.item.locale);
      settings.replace(result);return result.item;
    });
    settingsWrite.current=request.then(()=>undefined,()=>undefined);
    return request;
  },[settings.replace]);
  const setCoverMosaicDensity=useCallback((value:number)=>{
    if(!Number.isInteger(value)||value<MIN_MOSAIC_DENSITY||value>MAX_MOSAIC_DENSITY)return;
    mosaicDraftRef.current=value;setMosaicDraft(value);setCoverMosaicError(null);
  },[]);
  const saveCoverMosaicDensity=useCallback(()=>{
    if(mosaicTimer.current!==null){clearTimeout(mosaicTimer.current);mosaicTimer.current=null;}
    const value=mosaicDraftRef.current;
    if(value===null)return Promise.resolve();
    if(mosaicPending.current?.value===value)return mosaicPending.current.promise;
    const pending={value,promise:Promise.resolve()};
    mosaicPending.current=pending;setCoverMosaicSaving(true);setCoverMosaicError(null);
    pending.promise=saveSettings({coverMosaicDensity:value}).then(()=>{
      // A saved older value must not replace a newer drag preview.
      if(mosaicPending.current===pending&&mosaicDraftRef.current===value){
        mosaicDraftRef.current=null;setMosaicDraft(null);
      }
    }).catch(reason=>{
      if(mosaicPending.current===pending)setCoverMosaicError(reason);
    }).finally(()=>{
      if(mosaicPending.current===pending){mosaicPending.current=null;setCoverMosaicSaving(false);}
    });
    return pending.promise;
  },[saveSettings]);
  useEffect(()=>{
    if(mosaicDraft===null)return;
    // The provider stays mounted when the settings page is left.
    mosaicTimer.current=setTimeout(()=>void saveCoverMosaicDensity(),400);
    return()=>{if(mosaicTimer.current!==null)clearTimeout(mosaicTimer.current);};
  },[mosaicDraft,saveCoverMosaicDensity]);
  const coverMosaicDensity=mosaicDraft??settings.value?.item.coverMosaicDensity??DEFAULT_MOSAIC_DENSITY;
  const saveLocale=useCallback(async(value:AppLocale)=>{
    if(localePending.current)return;
    localePending.current=true;setLocaleSaving(true);
    try{await saveSettings({locale:value});}
    finally{localePending.current=false;setLocaleSaving(false);}
  },[saveSettings]);
  return {settings,saveSettings,saveLocale,localeSaving,coverMosaicDensity,setCoverMosaicDensity,saveCoverMosaicDensity,coverMosaicSaving,coverMosaicError,modelsRevision,refreshModels,sessionsRevision,refreshSessions,worldsRevision,refreshWorlds,worldCleanup,rememberWorldCleanup,forgetWorldCleanup};
}
const Context=createContext<ReturnType<typeof useData>|null>(null);
export function ManagementProvider({children}:{children:ReactNode}){
  const value=useData();
  const content=value.settings.value?children:value.settings.loading?<Loading/>:
    <div className="page"><ErrorNotice message={value.settings.error||'errors:loadFailed'} onRetry={value.settings.reload}/></div>;
  return <Context.Provider value={value}>{content}</Context.Provider>;
}
export function useManagement(){const value=useContext(Context);if(!value)throw Error('Missing ManagementProvider');return value;}
