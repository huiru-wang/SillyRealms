import {useEffect,useRef,useState} from 'react';
import {Button} from '../../components/ui/Button';
import {Input,Textarea} from '../../components/ui/Field';
import {Select} from '../../components/ui/Select';
import {Modal} from '../../components/ui/Modal';
import {api,ApiError,json} from '../../api';
import {ErrorNotice} from '../../app/ui';
import {usePagedResource} from '../../data';
import {useManagement} from '../../app/ManagementData';
import {usePresetStore} from '../presets/PresetStore';
import type {ModelConfig} from '../models/types';
import type {WorldDetail,WorldPatch} from './api/worlds';
import {parseTags} from './management';
import styles from './WorldDetailPage.module.css';
type Props={world:WorldDetail;onSaved:(world:WorldDetail)=>void};
const draftOf=(world:WorldDetail)=>({name:world.name,tags:world.tags.join('，'),defaultPresetId:world.defaultPresetId??'',defaultApiModelConfigId:world.defaultApiModelConfigId??''});
export function WorldMetadataForm(props:Props){return <WorldForm {...props} kind="metadata"/>;}
export function WorldDefaultsForm(props:Props){return <WorldForm {...props} kind="defaults"/>;}
function WorldForm({world,onSaved,kind}:Props&{kind:'metadata'|'defaults'}){
 const [baseline,setBaseline]=useState(world),[draft,setDraft]=useState(()=>draftOf(world)),[busy,setBusy]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false),[reloadConfirm,setReloadConfirm]=useState(false),[saved,setSaved]=useState(false);
 const pending=useRef(false),dirty=JSON.stringify(draft)!==JSON.stringify(draftOf(baseline));
 useEffect(()=>{if(!dirty){setBaseline(world);setDraft(draftOf(world));}},[world,dirty]);
 useEffect(()=>{if(!dirty)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty]);
 const change=(value:Partial<typeof draft>)=>{setDraft(current=>({...current,...value}));setSaved(false);};
 async function save(){
  if(pending.current||!dirty)return;
  const patch:WorldPatch={};
  if(kind==='metadata'){
   if(!draft.name.trim()){setError('请输入世界名称');return;}
   if(draft.name.trim()!==baseline.name)patch.name=draft.name.trim();
   const tags=parseTags(draft.tags);if(JSON.stringify(tags)!==JSON.stringify(baseline.tags))patch.tags=tags;
  }else{
   if((draft.defaultPresetId||null)!==baseline.defaultPresetId)patch.defaultPresetId=draft.defaultPresetId||null;
   if((draft.defaultApiModelConfigId||null)!==baseline.defaultApiModelConfigId)patch.defaultApiModelConfigId=draft.defaultApiModelConfigId||null;
  }
  if(!Object.keys(patch).length){setDraft(draftOf(baseline));return;}
  pending.current=true;setBusy(true);setError('');setSaved(false);
  try{const {item}=await api<{item:WorldDetail}>('v1/worlds/'+encodeURIComponent(world.id),{method:'PATCH',body:json({...patch,expectedRevision:baseline.revision})});setBaseline(item);setDraft(draftOf(item));setConflict(false);onSaved(item);setSaved(true);}
  catch(reason){setError(reason instanceof Error?reason.message:'保存失败');if(reason instanceof ApiError&&reason.errorCode==='WORLD_REVISION_CONFLICT')setConflict(true);}
  finally{pending.current=false;setBusy(false);}
 }
 async function reload(){
  if(pending.current)return;pending.current=true;setBusy(true);setError('');
  try{const {item}=await api<{item:WorldDetail}>('v1/worlds/'+encodeURIComponent(world.id));setBaseline(item);setDraft(draftOf(item));onSaved(item);setConflict(false);setReloadConfirm(false);}
  catch(reason){setError(reason instanceof Error?reason.message:'读取失败');}
  finally{pending.current=false;setBusy(false);}
 }
 return <div className="business-form">
  {kind==='metadata'?<div className="editor-form">
   <label>世界名称<Input value={draft.name} disabled={busy} onChange={e=>change({name:e.target.value})}/></label>
   <label>标签<Textarea value={draft.tags} disabled={busy} onChange={e=>change({tags:e.target.value})} rows={2} placeholder="用逗号或换行分隔"/></label>
  </div>:<><p className={styles.stateIntro}>仅用于之后创建会话时预填。可以留空，不影响已有会话。</p><DefaultsFields draft={draft} change={change} busy={busy}/></>}
  {error&&<ErrorNotice message={error}/>}
  <div className="actions"><Button variant="primary" loading={busy} disabled={!dirty} onClick={()=>void save()}>保存{kind==='metadata'?'名称与标签':'默认配置'}</Button>{dirty&&<Button disabled={busy} variant="ghost" onClick={()=>setReloadConfirm(true)}>放弃并重新读取</Button>}{conflict&&!dirty&&<Button onClick={()=>setReloadConfirm(true)}>重新读取</Button>}</div>
  {saved&&<p role="status">已保存。</p>}
  {reloadConfirm&&<Modal title="重新读取世界配置" onBeforeClose={()=>!pending.current} onClose={()=>setReloadConfirm(false)} footer={<><Button disabled={busy} onClick={()=>setReloadConfirm(false)}>继续编辑</Button><Button variant="primary" loading={busy} onClick={()=>void reload()}>放弃修改并读取</Button></>}><p>将放弃此表单的本地修改，读取服务端最新版本。</p>{error&&<ErrorNotice message={error}/>}</Modal>}
 </div>;
}
function DefaultsFields({draft,change,busy}:{draft:ReturnType<typeof draftOf>;change:(value:Partial<ReturnType<typeof draftOf>>)=>void;busy:boolean}){
 const presets=usePresetStore(),{modelsRevision}=useManagement();
 const models=usePagedResource<ModelConfig>('v1/api-model-configs?limit=100',modelsRevision,true);
 return <><div className="editor-form">
  <label>预设<Select aria-label="世界默认预设" value={draft.defaultPresetId} disabled={busy} onChange={e=>change({defaultPresetId:e.target.value})}><option value="">未设置</option>{draft.defaultPresetId&&!presets.presets.some(p=>p.id===draft.defaultPresetId)&&<option value={draft.defaultPresetId}>当前预设（列表未加载）</option>}{presets.presets.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Select></label>
  <label>模型<Select aria-label="世界默认模型" value={draft.defaultApiModelConfigId} disabled={busy} onChange={e=>change({defaultApiModelConfigId:e.target.value})}><option value="">未设置</option>{draft.defaultApiModelConfigId&&!models.page?.items.some(m=>m.id===draft.defaultApiModelConfigId)&&<option value={draft.defaultApiModelConfigId}>当前模型（列表未加载）</option>}{models.page?.items.map(m=><option key={m.id} value={m.id}>{m.name}{m.credentialStatus==='configured'?'':m.credentialStatus==='missing'?' · 未保存凭据':' · 凭据存储不可用'}</option>)}</Select></label>
 </div>{presets.error&&<ErrorNotice message={presets.error} onRetry={presets.reload}/>}{models.error&&<ErrorNotice message={models.error} onRetry={models.reload}/>}</>;
}
