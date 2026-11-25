import {createContext,useCallback,useContext,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {api,json} from '../api';
import {useResource} from '../data';
import {applyLocale} from '../i18n/instance.ts';
import type {AppLocale} from '@sillyrealms/sdk/locale';
import {ErrorNotice,Loading} from './ui';

export type AppSettings={defaultReplyAssistPresetId:string|null;defaultPresetId:string|null;defaultApiModelConfigId:string|null;locale:AppLocale};
function useData(){
  const settings=useResource<{item:AppSettings}>('v1/app-settings');
  const [modelsRevision,setModelsRevision]=useState(0),[sessionsRevision,setSessionsRevision]=useState(0);
  const [worldsRevision,setWorldsRevision]=useState(0);
  const [worldCleanup,setWorldCleanup]=useState<{id:string;name:string}[]>([]);
  const [localeSaving,setLocaleSaving]=useState(false);
  const localePending=useRef(false);
  const refreshWorlds=useCallback(()=>setWorldsRevision(n=>n+1),[]);
  const rememberWorldCleanup=useCallback((item:{id:string;name:string})=>setWorldCleanup(items=>[...items.filter(value=>value.id!==item.id),item]),[]);
  const forgetWorldCleanup=useCallback((id:string)=>setWorldCleanup(items=>items.filter(item=>item.id!==id)),[]);
  const refreshModels=useCallback(()=>setModelsRevision(n=>n+1),[]);
  const refreshSessions=useCallback(()=>setSessionsRevision(n=>n+1),[]);
  const locale=settings.value?.item.locale;
  useLayoutEffect(()=>{if(locale)void applyLocale(locale);},[locale]);
  const saveSettings=useCallback(async(patch:Partial<AppSettings>)=>{
    const result=await api<{item:AppSettings}>('v1/app-settings',{method:'PATCH',body:json(patch)});
    await applyLocale(result.item.locale);
    settings.replace(result);return result.item;
  },[settings.replace]);
  const saveLocale=useCallback(async(value:AppLocale)=>{
    if(localePending.current)return;
    localePending.current=true;setLocaleSaving(true);
    try{await saveSettings({locale:value});}
    finally{localePending.current=false;setLocaleSaving(false);}
  },[saveSettings]);
  return {settings,saveSettings,saveLocale,localeSaving,modelsRevision,refreshModels,sessionsRevision,refreshSessions,worldsRevision,refreshWorlds,worldCleanup,rememberWorldCleanup,forgetWorldCleanup};
}
const Context=createContext<ReturnType<typeof useData>|null>(null);
export function ManagementProvider({children}:{children:ReactNode}){
  const value=useData();
  const content=value.settings.value?children:value.settings.loading?<Loading/>:
    <div className="page"><ErrorNotice message={value.settings.error||'errors:loadFailed'} onRetry={value.settings.reload}/></div>;
  return <Context.Provider value={value}>{content}</Context.Provider>;
}
export function useManagement(){const value=useContext(Context);if(!value)throw Error('Missing ManagementProvider');return value;}
