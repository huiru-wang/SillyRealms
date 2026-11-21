import {createContext,useCallback,useContext,useState,type ReactNode} from 'react';
import {api,json} from '../api';
import {useResource} from '../data';

export type AppSettings={defaultPresetId:string|null;defaultApiModelConfigId:string|null};
function useData(){
  const settings=useResource<{item:AppSettings}>('v1/app-settings');
  const [modelsRevision,setModelsRevision]=useState(0),[sessionsRevision,setSessionsRevision]=useState(0);
  const [worldsRevision,setWorldsRevision]=useState(0);
  const [worldCleanup,setWorldCleanup]=useState<{id:string;name:string}[]>([]);
  const refreshWorlds=useCallback(()=>setWorldsRevision(n=>n+1),[]);
  const rememberWorldCleanup=useCallback((item:{id:string;name:string})=>setWorldCleanup(items=>[...items.filter(value=>value.id!==item.id),item]),[]);
  const forgetWorldCleanup=useCallback((id:string)=>setWorldCleanup(items=>items.filter(item=>item.id!==id)),[]);
  const refreshModels=useCallback(()=>setModelsRevision(n=>n+1),[]);
  const refreshSessions=useCallback(()=>setSessionsRevision(n=>n+1),[]);
  const saveSettings=useCallback(async(patch:Partial<AppSettings>)=>{
    const result=await api<{item:AppSettings}>('v1/app-settings',{method:'PATCH',body:json(patch)});
    settings.replace(result);return result.item;
  },[settings.replace]);
  return {settings,saveSettings,modelsRevision,refreshModels,sessionsRevision,refreshSessions,worldsRevision,refreshWorlds,worldCleanup,rememberWorldCleanup,forgetWorldCleanup};
}
const Context=createContext<ReturnType<typeof useData>|null>(null);
export function ManagementProvider({children}:{children:ReactNode}){const value=useData();return <Context.Provider value={value}>{children}</Context.Provider>;}
export function useManagement(){const value=useContext(Context);if(!value)throw Error('Missing ManagementProvider');return value;}
