import {useEffect,useRef,useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {Button} from '../../components/ui/Button';
import {Input} from '../../components/ui/Field';
import {Select} from '../../components/ui/Select';
import {Modal} from '../../components/ui/Modal';
import {api,ApiError,json} from '../../api';
import {usePagedResource,useResource} from '../../data';
import {ErrorNotice,Loading} from '../../app/ui';
import {useManagement} from '../../app/ManagementData';
import {usePresetStore} from '../presets/PresetStore';
import type {ModelConfig} from '../models/types';
import type {WorldDetail as WorldChoice,WorldListItem as WorldSummary} from '../worlds/api/worlds';
import type {Session} from './types';
import {initialSessionSelection} from './creation';
import {WorldAssetImage} from '../../world-assets';
import worldStyles from '../worlds/WorldDetailPage.module.css';
export function CreateSessionDialog({onClose,worldId:initialWorldId,lockedWorld=false,worldContext}:{onClose:()=>void;worldId:string;lockedWorld?:boolean;worldContext?:{characterId:string;openingName:string}}){
 const navigate=useNavigate(),{modelsRevision,refreshSessions}=useManagement(),presets=usePresetStore();
 const worlds=usePagedResource<WorldSummary>('v1/worlds?limit=100',0,true);
 const models=usePagedResource<ModelConfig>('v1/api-model-configs?limit=100',modelsRevision,true);
 const [worldId,setWorldId]=useState(initialWorldId),[character,setCharacter]=useState(''),[preset,setPreset]=useState(''),[model,setModel]=useState(''),[title,setTitle]=useState(worldContext?.openingName??'');
 const world=useResource<{item:WorldChoice}>(worldId?'v1/worlds/'+encodeURIComponent(worldId):null);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),pending=useRef(false);
 const creationId=useRef(crypto.randomUUID());
 useEffect(()=>{
  const item=world.value?.item;if(!item)return;
  const selection=initialSessionSelection(item,worldContext?.characterId);
  setCharacter(selection.character);setPreset(selection.preset);setModel(selection.model);
 },[world.value,worldContext?.characterId]);
 const roles=world.value?.item.characters.filter(c=>c.player_selectable)??[];
 const selectedRole=roles.find(role=>role.id===character);
 const valid=!!world.value&&roles.some(c=>c.id===character)&&presets.presets.some(p=>p.id===preset)&&!!models.page?.items.some(m=>m.id===model);
 const submit=async()=>{
  if(!valid||pending.current)return;pending.current=true;setBusy(true);setError('');
  const body={id:creationId.current,worldId,userCharacterId:character,presetId:preset,apiModelConfigId:model,title:title.trim()||null};
  try{
   let result:{item:Session};
   try{result=await api<{item:Session}>('v1/sessions',{method:'POST',body:json(body)});}
   catch(reason){
    if(!(reason instanceof ApiError)||!['SERVER_UNAVAILABLE','INVALID_RESPONSE','RESOURCE_CONFLICT'].includes(reason.errorCode))throw reason;
    const recovered=await api<{item:Session}>('v1/sessions/'+encodeURIComponent(body.id)).catch(()=>null);
    if(!recovered||recovered.item.worldId!==body.worldId||recovered.item.userCharacterId!==body.userCharacterId)throw reason;
    result=recovered;
   }
   refreshSessions();onClose();navigate('/sessions/'+encodeURIComponent(result.item.id));
  }catch(reason){setError(reason instanceof Error?reason.message:'创建失败');}
  finally{pending.current=false;setBusy(false);}
 };
 return <Modal title="创建会话" onBeforeClose={()=>!pending.current} onClose={onClose} footer={<><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" disabled={!valid} loading={busy} onClick={()=>void submit()}>创建会话</Button></>}>
  {worldContext?<><dl className={worldStyles.startSummary}>
   <div><dt>当前开局</dt><dd>{worldContext.openingName}</dd></div>
   <div><dt>扮演角色</dt><dd><span className={worldStyles.startAvatar} aria-hidden="true"><WorldAssetImage worldId={worldId} source={selectedRole?.avatar}/></span><span>{selectedRole?.name??'正在读取角色…'}</span></dd></div>
  </dl><p>仅创建基础会话，不执行开局或初始化消息。</p></>:<p>选择世界、玩家身份及绑定配置，创建基础会话记录。</p>}
  <div className="editor-form">
   {!worldContext&&<><label>标题<Input aria-label="会话标题" value={title} disabled={busy} onChange={e=>setTitle(e.target.value)} placeholder="可留空"/></label>
   <label>世界<Select aria-label="世界" value={worldId} disabled={busy||lockedWorld} onChange={e=>{setWorldId(e.target.value);setCharacter('');setPreset('');setModel('');creationId.current=crypto.randomUUID();setError('');}}><option value="">选择世界</option>{worldId&&!worlds.page?.items.some(w=>w.id===worldId)&&<option value={worldId}>{world.value?.item.name??"当前世界"}</option>}{worlds.page?.items.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</Select></label>
   <label>玩家角色<Select aria-label="玩家角色" value={character} disabled={busy||world.loading} onChange={e=>{setCharacter(e.target.value);creationId.current=crypto.randomUUID();}}><option value="">选择可扮演角色</option>{roles.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</Select></label></>}
   <label>预设<Select aria-label="会话预设" value={preset} disabled={busy} onChange={e=>setPreset(e.target.value)}><option value="">选择预设</option>{presets.presets.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Select></label>
   <label>模型<Select aria-label="会话模型" value={model} disabled={busy} onChange={e=>setModel(e.target.value)}><option value="">选择模型</option>{models.page?.items.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</Select></label>
  </div>
  <p><a href="/presets" target="_blank" rel="noreferrer">管理预设</a> · <a href="/models" target="_blank" rel="noreferrer">管理模型</a> <Button size="compact" disabled={busy} onClick={()=>{presets.reload();models.reload();}}>刷新配置目录</Button></p>
  {worlds.page?.items.length===0&&<p>当前 Server V2 中还没有世界数据，暂时无法创建会话。</p>}
  {(worlds.loading||world.loading||models.loading||presets.loading)&&<Loading/>}
  {error&&<ErrorNotice message={error}/>}{worlds.error&&<ErrorNotice message={worlds.error} onRetry={worlds.reload}/>}{world.error&&<ErrorNotice message={world.error} onRetry={world.reload}/>}{models.error&&<ErrorNotice message={models.error} onRetry={models.reload}/>}{presets.error&&<ErrorNotice message={presets.error} onRetry={presets.reload}/>}
 </Modal>;
}
