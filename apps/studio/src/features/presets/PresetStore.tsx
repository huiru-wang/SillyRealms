import {createContext,useCallback,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import {api,json} from '../../api';
import type {StudioPreset} from './types';
import {fromServer,getPresetValidationError,presetPatch} from './adapter';
export {getPresetValidationError} from './adapter';
const clone=<T,>(value:T):T=>structuredClone(value);
type State={savedById:Record<string,StudioPreset>;draftById:Record<string,StudioPreset>;order:string[];defaultPresetId:string|null};
const initial:State={savedById:{},draftById:{},order:[],defaultPresetId:null};
function useStore(){
 const [state,setState]=useState<State>(initial),[loading,setLoading]=useState(true),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const current=useRef(state),pending=useRef(false),generation=useRef(0);current.current=state;
 const change=useCallback((fn:(s:State)=>State)=>{const next=fn(current.current);current.current=next;setState(next);},[]);
 const reload=useCallback(async()=>{
  const epoch=++generation.current;setLoading(true);setError('');
  try{const settings=await api('v1/app-settings');let cursor:string|null=null;const items:StudioPreset[]=[];
   do {const page:any=await api('v1/presets?limit=100'+(cursor?'&cursor='+encodeURIComponent(cursor):''));const details=await Promise.all(page.items.map((p:any)=>api('v1/presets/'+encodeURIComponent(p.id))));items.push(...details.map(d=>fromServer(d.item)));cursor=page.hasMore?page.nextCursor:null;}while(cursor&&epoch===generation.current);
   if(epoch!==generation.current)return;
   change(s=>{const saved=Object.fromEntries(items.map(p=>[p.id,p]));return {order:items.map(p=>p.id),savedById:saved,draftById:Object.fromEntries(items.map(p=>[p.id,s.draftById[p.id]&&JSON.stringify(s.draftById[p.id])!==JSON.stringify(s.savedById[p.id])?s.draftById[p.id]:clone(p)])),defaultPresetId:settings.item.defaultPresetId};});
  }catch(e){if(epoch===generation.current)setError(e instanceof Error?e.message:'预设加载失败');}finally{if(epoch===generation.current)setLoading(false);}
 },[change]);
 useEffect(()=>{void reload();return()=>{generation.current++;};},[reload]);
 useEffect(()=>{const handler=()=>void reload();window.addEventListener('sr:settings-changed',handler);return()=>window.removeEventListener('sr:settings-changed',handler);},[reload]);
 const mutate=async<T,>(fn:()=>Promise<T>):Promise<T>=>{if(pending.current)throw Error('正在保存，请稍候');pending.current=true;setBusy(true);setError('');try{return await fn();}catch(e){setError(e instanceof Error?e.message:'操作失败');throw e;}finally{pending.current=false;setBusy(false);}};
 const insert=(raw:any)=>{const p=fromServer(raw);change(s=>({...s,order:[p.id,...s.order.filter(id=>id!==p.id)],savedById:{...s.savedById,[p.id]:p},draftById:{...s.draftById,[p.id]:clone(p)}}));return p.id;};
 const createPreset=()=>mutate(async()=>{const defaults=await api('v1/presets/default');const result=await api('v1/presets',{method:'POST',body:json({...defaults,name:'未命名预设'})});return insert(result.item);});
 const getDefaultPrompt=async(nodeId:string):Promise<string>=>{
  const defaults=await api('v1/presets/default');
  const node=defaults.config_json.nodes.find((item:{id:string;prompt:string})=>item.id===nodeId);
  if(!node||typeof node.prompt!=='string')throw Error('找不到此节点的默认提示词。');
  return node.prompt;
 };
 const importPreset=(text:string)=>mutate(async()=>{const result=await api('v1/presets/import',{method:'POST',body:text});return insert(result.item);});
 const savePreset=(id:string)=>mutate(async()=>{const p=clone(current.current.draftById[id]);const error=getPresetValidationError(p);if(error)throw Error(error);await api('v1/presets/'+encodeURIComponent(id),{method:'PATCH',headers:{'If-Match':p.raw.etag},body:json(presetPatch(p))});const result=await api('v1/presets/'+encodeURIComponent(id));const saved=fromServer(result.item);change(s=>({...s,savedById:{...s.savedById,[id]:saved},draftById:{...s.draftById,[id]:JSON.stringify(s.draftById[id])===JSON.stringify(p)?clone(saved):{...s.draftById[id],raw:saved.raw}}}));return true;});
 const duplicatePreset=(id:string)=>mutate(async()=>{const p=current.current.draftById[id];const error=getPresetValidationError(p);if(error)throw Error(error);const result=await api('v1/presets',{method:'POST',body:json({...presetPatch(p),name:p.name+' 副本'})});return insert(result.item);});
 const deletePreset=(id:string)=>mutate(async()=>{await api('v1/presets/'+encodeURIComponent(id),{method:'DELETE'});change(s=>{const saved={...s.savedById},draft={...s.draftById};delete saved[id];delete draft[id];return {...s,order:s.order.filter(n=>n!==id),savedById:saved,draftById:draft};});});
 const setDefaultPreset=(id:string)=>mutate(async()=>{await api('v1/app-settings',{method:'PATCH',body:json({defaultPresetId:id})});change(s=>({...s,defaultPresetId:id}));});
 const editPreset=(id:string,fn:(p:StudioPreset)=>StudioPreset)=>change(s=>({...s,draftById:{...s.draftById,[id]:fn(clone(s.draftById[id]))}}));
 const revertPreset=(id:string)=>change(s=>({...s,draftById:{...s.draftById,[id]:clone(s.savedById[id])}}));
 const isDirty=(id:string)=>JSON.stringify(state.draftById[id])!==JSON.stringify(state.savedById[id]);
 const dirty=state.order.some(isDirty);useEffect(()=>{if(!dirty)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty]);
 return {...state,presets:state.order.map(id=>state.draftById[id]),loading,error,busy,reload,getDefaultPrompt,importPreset,createPreset,savePreset,duplicatePreset,deletePreset,setDefaultPreset,editPreset,revertPreset,isDirty};
}
const Context=createContext<ReturnType<typeof useStore>|null>(null);
export function PresetProvider({children}:{children:ReactNode}){const store=useStore();return <Context.Provider value={store}>{children}</Context.Provider>;}
export function usePresetStore(){const value=useContext(Context);if(!value)throw Error('Missing preset provider');return value;}
