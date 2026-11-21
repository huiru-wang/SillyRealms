import {createContext,useCallback,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import {api,ApiError,json} from '../../api';
import {usePagedResource} from '../../data';
import {useManagement} from '../../app/ManagementData';
import type {PresetDetail,PresetInput,PresetSummary,WebPreset} from './types';
import {fromServer,getPresetValidationError,presetInput} from './adapter';
export {getPresetValidationError} from './adapter';
const clone=<T,>(value:T):T=>structuredClone(value);
type State={savedById:Record<string,WebPreset>;draftById:Record<string,WebPreset>;conflicts:Record<string,boolean>};
const initial:State={savedById:{},draftById:{},conflicts:{}};
function useStore(){
 const {settings,saveSettings}=useManagement();
 const catalog=usePagedResource<PresetSummary>('v1/presets?type=narrative&limit=100',0,true);
 const [state,setState]=useState<State>(initial),[busy,setBusy]=useState(false);
 const [detailErrors,setDetailErrors]=useState<Record<string,string>>({}),[detailsLoading,setDetailsLoading]=useState<Record<string,boolean>>({});
 const current=useRef(state),pending=useRef(false),requests=useRef(new Map<string,Promise<void>>());current.current=state;
 const change=useCallback((fn:(s:State)=>State)=>{const next=fn(current.current);current.current=next;setState(next);},[]);
 const loadDetail=useCallback((id:string,discard=false):Promise<void>=>{
  if(!discard&&current.current.draftById[id])return Promise.resolve();
  const running=requests.current.get(id);if(running)return running;
  setDetailsLoading(s=>({...s,[id]:true}));setDetailErrors(s=>({...s,[id]:''}));
  const task=api<{item:PresetDetail}>('v1/presets/'+encodeURIComponent(id)).then(({item})=>{
   const value=fromServer(item);
   change(s=>({...s,savedById:{...s.savedById,[id]:value},draftById:{...s.draftById,[id]:clone(value)},conflicts:{...s.conflicts,[id]:false}}));
  }).catch(error=>{setDetailErrors(s=>({...s,[id]:error instanceof Error?error.message:'预设加载失败'}));})
   .finally(()=>{requests.current.delete(id);setDetailsLoading(s=>({...s,[id]:false}));});
  requests.current.set(id,task);return task;
 },[change]);
 const mutate=async<T,>(fn:()=>Promise<T>):Promise<T>=>{
  if(pending.current)throw Error('正在保存，请稍候');pending.current=true;setBusy(true);
  try{return await fn();}finally{pending.current=false;setBusy(false);}
 };
 const insert=(item:PresetDetail)=>{const p=fromServer(item);change(s=>({...s,savedById:{...s.savedById,[p.id]:p},draftById:{...s.draftById,[p.id]:clone(p)}}));catalog.reload();return p.id;};
 const availableName=(base:string)=>{
  const names=new Set([...(catalog.page?.items??[]).map(p=>p.name),...Object.values(current.current.savedById).map(p=>p.name)]);
  let name=base,index=1;while(names.has(name))name=base+' ('+(index++)+')';return name;
 };
 const createPreset=()=>mutate(async()=>{
  const defaults=await api<{item:PresetInput}>('v1/presets/default?type=narrative');
  const {item}=await api<{item:PresetDetail}>('v1/presets',{method:'POST',body:json({...defaults.item,name:availableName('未命名预设')})});return insert(item);
 });
 const getDefaultPrompt=async(nodeId:string)=>{
  const {item}=await api<{item:PresetInput}>('v1/presets/default?type=narrative');
  const node=item.config.nodes.find(node=>node.id===nodeId);if(!node)throw Error('找不到默认提示词');return node.prompt;
 };
 const importPreset=(text:string)=>mutate(async()=>insert((await api<{item:PresetDetail}>('v1/presets/import',{method:'POST',body:text})).item));
 const savePreset=(id:string)=>mutate(async()=>{
  const submitted=clone(current.current.draftById[id]);const error=getPresetValidationError(submitted);if(error)throw Error(error);
  try{
   const {item}=await api<{item:PresetDetail}>('v1/presets/'+encodeURIComponent(id),{method:'PATCH',body:json({...presetInput(submitted),expectedRevision:submitted.revision})});
   const saved=fromServer(item);
   change(s=>({...s,savedById:{...s.savedById,[id]:saved},draftById:{...s.draftById,[id]:JSON.stringify(s.draftById[id])===JSON.stringify(submitted)?clone(saved):{...s.draftById[id],revision:saved.revision}},conflicts:{...s.conflicts,[id]:false}}));
   catalog.reload();return true;
  }catch(error){if(error instanceof ApiError&&error.errorCode==='PRESET_REVISION_CONFLICT')change(s=>({...s,conflicts:{...s.conflicts,[id]:true}}));throw error;}
 });
 const duplicatePreset=(id:string)=>mutate(async()=>{
  const p=current.current.draftById[id];const error=getPresetValidationError(p);if(error)throw Error(error);
  return insert((await api<{item:PresetDetail}>('v1/presets',{method:'POST',body:json({...presetInput(p),name:availableName(p.name+' 副本')})})).item);
 });
 const deletePreset=(id:string)=>mutate(async()=>{
  await api('v1/presets/'+encodeURIComponent(id),{method:'DELETE'});
  change(s=>{const saved={...s.savedById},draft={...s.draftById};delete saved[id];delete draft[id];return {...s,savedById:saved,draftById:draft};});catalog.reload();
 });
 const setDefaultPreset=(id:string)=>mutate(()=>saveSettings({defaultPresetId:id}));
 const editPreset=(id:string,fn:(p:WebPreset)=>WebPreset)=>change(s=>({...s,draftById:{...s.draftById,[id]:fn(clone(s.draftById[id]))}}));
 const revertPreset=(id:string)=>change(s=>({...s,draftById:{...s.draftById,[id]:clone(s.savedById[id])}}));
 const isDirty=(id:string)=>JSON.stringify(state.draftById[id])!==JSON.stringify(state.savedById[id]);
 const dirty=Object.keys(state.draftById).some(isDirty);
 useEffect(()=>{if(!dirty)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty]);
 const summaries=catalog.page?.items??[];
 return {...state,presets:summaries,defaultPresetId:settings.value?.item.defaultPresetId??null,
  loading:catalog.loading,error:catalog.error,busy,reload:catalog.reload,loadDetail,detailErrors,detailsLoading,
  getDefaultPrompt,importPreset,createPreset,savePreset,duplicatePreset,deletePreset,setDefaultPreset,editPreset,revertPreset,isDirty};
}
const Context=createContext<ReturnType<typeof useStore>|null>(null);
export function PresetProvider({children}:{children:ReactNode}){const store=useStore();return <Context.Provider value={store}>{children}</Context.Provider>;}
export function usePresetStore(){const value=useContext(Context);if(!value)throw Error('Missing preset provider');return value;}
