import {createContext,useCallback,useContext,useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {DEFAULT_PRESET_ID,DEFAULT_SUMMARY_PROMPT,presetFixtures,type StudioPreset} from '../../fixtures/presets';

type PresetState = {
  order: string[];
  savedById: Record<string,StudioPreset>;
  draftById: Record<string,StudioPreset>;
  defaultPresetId: string | null;
};

export type PresetStoreValue = {
  presets: StudioPreset[];
  savedById: Readonly<Record<string,StudioPreset>>;
  draftById: Readonly<Record<string,StudioPreset>>;
  defaultPresetId: string | null;
  editPreset: (id:string,updater:(draft:StudioPreset)=>StudioPreset)=>void;
  savePreset: (id:string)=>boolean;
  revertPreset: (id:string)=>void;
  createPreset: ()=>string;
  duplicatePreset: (id:string)=>string;
  deletePreset: (id:string)=>void;
  setDefaultPreset: (id:string)=>void;
  isDirty: (id:string)=>boolean;
};

const PresetContext=createContext<PresetStoreValue|null>(null);

// Copy nested data and keep key order stable for saved/draft comparisons.
function clonePreset(preset:StudioPreset):StudioPreset{
  return {
    id:preset.id,name:preset.name,description:preset.description,
    contextStrategy:preset.contextStrategy,maxOutputTokens:preset.maxOutputTokens,
    temperature:preset.temperature,summaryPrompt:preset.summaryPrompt,
    style:{content:preset.style.content,enabled:preset.style.enabled},
    customNodes:preset.customNodes.map(node=>({
      id:node.id,name:node.name,role:node.role,content:node.content,enabled:node.enabled,
    })),
  };
}

function initialState():PresetState{
  const savedById=Object.fromEntries(presetFixtures.map(preset=>[preset.id,clonePreset(preset)]));
  const draftById=Object.fromEntries(presetFixtures.map(preset=>[preset.id,clonePreset(preset)]));
  return {order:presetFixtures.map(preset=>preset.id),savedById,draftById,defaultPresetId:DEFAULT_PRESET_ID};
}

function differs(state:PresetState,id:string){
  return !!state.draftById[id] && JSON.stringify(state.draftById[id])!==JSON.stringify(state.savedById[id]);
}

let sequence=0;
function makeId(prefix:string){
  sequence+=1;
  // randomUUID is unavailable on some local-network HTTP origins.
  const token=globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)+'-'+sequence.toString(36);
  return prefix+'-'+token;
}

function uniqueName(base:string,presets:Record<string,StudioPreset>){
  const names=new Set(Object.values(presets).map(preset=>preset.name.trim()));
  let name=base;
  for(let suffix=2;names.has(name);suffix++)name=base+' '+suffix;
  return name;
}

export function getPresetValidationError(preset:StudioPreset):string|null{
  if(!preset.name.trim())return '请输入预设名称。';
  if(!['compact','standard','extended'].includes(preset.contextStrategy))return '请选择有效的上下文策略。';
  if(!Number.isSafeInteger(preset.maxOutputTokens)||preset.maxOutputTokens<=0)return '最大输出 Token 必须是大于 0 的整数。';
  if(!Number.isFinite(preset.temperature)||preset.temperature<0||preset.temperature>2)return '温度需要在 0 到 2 之间。';
  if(typeof preset.description!=='string'||typeof preset.summaryPrompt!=='string')return '请检查简介与摘要提示词。';
  if(typeof preset.style.content!=='string'||typeof preset.style.enabled!=='boolean')return '请检查叙事风格内容。';
  const ids=new Set<string>();
  for(const [index,node] of preset.customNodes.entries()){
    if(!node.id||ids.has(node.id))return '自定义节点配置重复，请检查后重试。';
    ids.add(node.id);
    if(!node.name.trim())return '第 '+(index+1)+' 个自定义节点需要名称。';
    if(!['system','user','assistant'].includes(node.role))return '请选择有效的节点消息角色。';
    if(typeof node.content!=='string'||typeof node.enabled!=='boolean')return '请检查自定义节点内容。';
  }
  return null;
}

/** A route-independent, in-memory editor store. Reloading restores the fixtures. */
export function PresetProvider({children}:{children:ReactNode}){
  const [state,setState]=useState(initialState);
  const current=useRef(state);
  const change=useCallback((updater:(previous:PresetState)=>PresetState)=>{
    const next=updater(current.current);
    if(next===current.current)return;
    // Commands see pending edits even when several actions share a React batch.
    current.current=next;
    setState(next);
  },[]);

  const editPreset=useCallback((id:string,updater:(draft:StudioPreset)=>StudioPreset)=>{
    change(previous=>{
      const draft=previous.draftById[id];
      if(!draft)return previous;
      const next=clonePreset({...updater(clonePreset(draft)),id});
      if(JSON.stringify(next)===JSON.stringify(draft))return previous;
      return {...previous,draftById:{...previous.draftById,[id]:next}};
    });
  },[change]);

  const savePreset=useCallback((id:string)=>{
    const draft=current.current.draftById[id];
    if(!draft||getPresetValidationError(draft))return false;
    const saved=clonePreset(draft);
    saved.name=saved.name.trim();
    saved.customNodes=saved.customNodes.map(node=>({...node,name:node.name.trim()}));
    change(previous=>({
      ...previous,savedById:{...previous.savedById,[id]:saved},
      draftById:{...previous.draftById,[id]:clonePreset(saved)},
    }));
    return true;
  },[change]);

  const revertPreset=useCallback((id:string)=>{
    change(previous=>{
      const saved=previous.savedById[id];
      if(!saved||!differs(previous,id))return previous;
      return {...previous,draftById:{...previous.draftById,[id]:clonePreset(saved)}};
    });
  },[change]);

  const createPreset=useCallback(()=>{
    const id=makeId('preset');
    change(previous=>{
      const preset:StudioPreset={
        id,name:uniqueName('未命名预设',previous.draftById),description:'',
        contextStrategy:'standard',maxOutputTokens:4096,temperature:1,
        summaryPrompt:DEFAULT_SUMMARY_PROMPT,style:{content:'',enabled:true},customNodes:[],
      };
      return {
        order:[id,...previous.order],savedById:{...previous.savedById,[id]:clonePreset(preset)},
        draftById:{...previous.draftById,[id]:preset},defaultPresetId:previous.defaultPresetId??id,
      };
    });
    return id;
  },[change]);

  const duplicatePreset=useCallback((sourceId:string)=>{
    const source=current.current.draftById[sourceId];
    if(!source)throw new Error('预设已不存在。');
    const id=makeId('preset');
    const name=uniqueName((source.name.trim()||'未命名预设')+' 副本',current.current.draftById);
    const nodeIds=new Map<string,string>();
    const copy=(preset:StudioPreset):StudioPreset=>({
      ...clonePreset(preset),id,name,
      customNodes:preset.customNodes.map(node=>{
        if(!nodeIds.has(node.id))nodeIds.set(node.id,makeId('node'));
        return {...node,id:nodeIds.get(node.id)!};
      }),
    });
    const draft=copy(source);
    // Preserve an editable invalid draft without recording it as a valid save.
    const baseline=getPresetValidationError(draft)
      ? copy(current.current.savedById[sourceId]??source)
      : clonePreset(draft);
    change(previous=>{
      const order=[...previous.order];
      order.splice(order.indexOf(sourceId)+1,0,id);
      return {
        ...previous,order,savedById:{...previous.savedById,[id]:baseline},
        draftById:{...previous.draftById,[id]:draft},
      };
    });
    return id;
  },[change]);

  const deletePreset=useCallback((id:string)=>{
    change(previous=>{
      const index=previous.order.indexOf(id);
      if(index<0)return previous;
      const order=previous.order.filter(item=>item!==id);
      const savedById={...previous.savedById},draftById={...previous.draftById};
      delete savedById[id];
      delete draftById[id];
      return {
        order,savedById,draftById,
        defaultPresetId:previous.defaultPresetId===id
          ? order[index]??order.at(-1)??null
          : previous.defaultPresetId,
      };
    });
  },[change]);

  const setDefaultPreset=useCallback((id:string)=>{
    change(previous=>previous.draftById[id]&&previous.defaultPresetId!==id
      ? {...previous,defaultPresetId:id}
      : previous);
  },[change]);

  const dirtyIds=useMemo(()=>new Set(state.order.filter(id=>differs(state,id))),[state]);
  const hasDirty=dirtyIds.size>0;
  useEffect(()=>{
    if(!hasDirty)return;
    const warn=(event:BeforeUnloadEvent)=>{
      if(!current.current.order.some(id=>differs(current.current,id)))return;
      event.preventDefault();
      event.returnValue='';
    };
    window.addEventListener('beforeunload',warn);
    return()=>window.removeEventListener('beforeunload',warn);
  },[hasDirty]);

  const isDirty=useCallback((id:string)=>dirtyIds.has(id),[dirtyIds]);
  const value=useMemo<PresetStoreValue>(()=>({
    presets:state.order.map(id=>state.draftById[id]),
    savedById:state.savedById,draftById:state.draftById,defaultPresetId:state.defaultPresetId,
    editPreset,savePreset,revertPreset,createPreset,duplicatePreset,deletePreset,setDefaultPreset,isDirty,
  }),[state,editPreset,savePreset,revertPreset,createPreset,duplicatePreset,deletePreset,setDefaultPreset,isDirty]);

  return <PresetContext.Provider value={value}>{children}</PresetContext.Provider>;
}

export function usePresetStore(){
  const store=useContext(PresetContext);
  if(!store)throw new Error('usePresetStore must be used within PresetProvider');
  return store;
}
