import {errorKey} from '../../i18n/errors.ts';
import {useTranslation} from 'react-i18next';
import {i18n} from '../../i18n/instance.ts';
import {randomId} from '../../random-id';
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
export function CreateSessionDialog({onClose,worldId:initialWorldId,lockedWorld=false,worldContext}:{onClose:()=>void;worldId:string;lockedWorld?:boolean;worldContext?:{characterId:string;openingId:string;openingName:string}}){
  useTranslation();
 const navigate=useNavigate(),{modelsRevision,refreshSessions}=useManagement(),presets=usePresetStore();
 const worlds=usePagedResource<WorldSummary>('v1/worlds?limit=100',0,true);
 const models=usePagedResource<ModelConfig>('v1/api-model-configs?limit=100',modelsRevision,true);
 const [worldId,setWorldId]=useState(initialWorldId),[character,setCharacter]=useState(''),[opening,setOpening]=useState(''),[preset,setPreset]=useState(''),[model,setModel]=useState(''),[title,setTitle]=useState(worldContext?.openingName??'');
 const [replyPreset,setReplyPreset]=useState<string|null>(null);
 const world=useResource<{item:WorldChoice}>(worldId?'v1/worlds/'+encodeURIComponent(worldId):null);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),pending=useRef(false);
 const creationRequest=useRef<{key:string;id:string}|null>(null);
 useEffect(()=>{
  const item=world.value?.item;if(!item)return;
  const selection=initialSessionSelection(item,worldContext?.characterId,worldContext?.openingId);
  setOpening(selection.opening);setCharacter(selection.character);setPreset(selection.preset);setReplyPreset(selection.replyPreset);setModel(selection.model);
 },[world.value,worldContext?.characterId,worldContext?.openingId]);
 const roles=world.value?.item.characters.filter(c=>c.player_selectable)??[];
 const selectedRole=roles.find(role=>role.id===character);
 const openings=world.value?.item.openings??[];
 const selectedOpening=openings.find(item=>item.id===opening);
 const valid=world.value?.item.id===worldId&&!!selectedOpening&&roles.some(c=>c.id===character)&&presets.presets.some(p=>p.id===preset)&&!!models.page?.items.some(m=>m.id===model);
 const submit=async()=>{
  if(!valid||pending.current)return;pending.current=true;setBusy(true);setError('');
  const input={worldId,openingId:opening,userCharacterId:character,runtimeConfig:{narrativePresetId:preset,apiModelConfigId:model,replyAssistPresetId:replyPreset},...(title.trim()?{title:title.trim()}: {})};
  const key=JSON.stringify(input);
  if(creationRequest.current?.key!==key)creationRequest.current={key,id:randomId()};
  const body={...input,id:creationRequest.current.id};
  try{
   let result:{item:Session};
   try{result=await api<{item:Session}>('v1/sessions',{method:'POST',body:json(body)});}
   catch(reason){
    if(!(reason instanceof ApiError)||!['SERVER_UNAVAILABLE','INVALID_RESPONSE','RESOURCE_CONFLICT'].includes(reason.errorCode))throw reason;
    const recovered=await api<{item:Session}>('v1/sessions/'+encodeURIComponent(body.id)).catch(()=>null);
    if(!recovered||recovered.item.worldId!==body.worldId||recovered.item.userCharacterId!==body.userCharacterId||recovered.item.runtimeConfig.narrativePresetId!==preset||recovered.item.runtimeConfig.apiModelConfigId!==model||recovered.item.runtimeConfig.replyAssistPresetId!==replyPreset||!recovered.item.tipEntryId)throw reason;
    result=recovered;
   }
   refreshSessions();onClose();navigate('/sessions/'+encodeURIComponent(result.item.id));
  }catch(reason){setError(errorKey(reason,"common:createFailed"));}
  finally{pending.current=false;setBusy(false);}
 };
 return <Modal title={i18n.t("sessions:create")} onBeforeClose={()=>!pending.current} onClose={onClose} footer={<><Button disabled={busy} onClick={onClose}>{i18n.t("common:cancel")}</Button><Button variant="primary" disabled={!valid} loading={busy} onClick={()=>void submit()}>{i18n.t("sessions:create")}</Button></>}>
  {worldContext?<><dl className={worldStyles.startSummary}>
   <div><dt>{i18n.t("sessions:currentOpening")}</dt><dd>{worldContext.openingName}</dd></div>
   <div><dt>{i18n.t("sessions:playAs")}</dt><dd><span className={worldStyles.startAvatar} aria-hidden="true"><WorldAssetImage worldId={worldId} source={selectedRole?.avatar}/></span><span>{selectedRole?.name??i18n.t("sessions:loadingCharacters")}</span></dd></div>
  </dl><p>{i18n.t("sessions:openingConfirmation")}</p></>:<p>{i18n.t("sessions:createDescription")}</p>}
  <div className="editor-form">
   {!worldContext&&<><label>{i18n.t("common:title")}<Input aria-label={i18n.t("sessions:title")} value={title} disabled={busy} onChange={e=>setTitle(e.target.value)} placeholder={i18n.t("sessions:optional")}/></label>
   <label>{i18n.t("common:world")}<Select aria-label={i18n.t("common:world")} value={worldId} disabled={busy||lockedWorld} onChange={e=>{setWorldId(e.target.value);setOpening('');setCharacter('');setPreset('');setReplyPreset(null);setModel('');setError('');}}><option value="">{i18n.t("sessions:chooseWorld")}</option>{worldId&&!worlds.page?.items.some(w=>w.id===worldId)&&<option value={worldId}>{world.value?.item.name??i18n.t("sessions:currentWorld")}</option>}{worlds.page?.items.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</Select></label>
   <label>{i18n.t("sessions:opening")}<Select aria-label={i18n.t("sessions:openingLabel")} value={opening} disabled={busy||world.loading} onChange={e=>setOpening(e.target.value)}><option value="">{i18n.t("sessions:chooseOpening")}</option>{openings.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>
   <label>{i18n.t("sessions:playerCharacter")}<Select aria-label={i18n.t("sessions:playerCharacter")} value={character} disabled={busy||world.loading} onChange={e=>{setCharacter(e.target.value);}}><option value="">{i18n.t("sessions:chooseCharacter")}</option>{roles.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</Select></label></>}
   <label>{i18n.t("sessions:narrativePreset")}<Select aria-label={i18n.t("sessions:narrativePreset")} value={preset} disabled={busy} onChange={e=>setPreset(e.target.value)}><option value="">{i18n.t("sessions:choosePreset")}</option>{presets.presets.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Select></label>
   <label>{i18n.t("sessions:assistPreset")}<Select aria-label={i18n.t("sessions:assistPreset")} value={replyPreset??''} disabled={busy} onChange={e=>setReplyPreset(e.target.value||null)}>
    <option value="">{i18n.t("sessions:followAppDefault")}</option>
    {replyPreset&&!presets.replyPresets.some(p=>p.id===replyPreset)&&<option value={replyPreset}>{i18n.t('worlds:currentPresetListNotLoaded')}</option>}
    {presets.replyPresets.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
   </Select></label>
   <label>{i18n.t("common:models")}<Select aria-label={i18n.t("sessions:modelLabel")} value={model} disabled={busy} onChange={e=>setModel(e.target.value)}><option value="">{i18n.t("sessions:chooseModel")}</option>{models.page?.items.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</Select></label>
  </div>
  {worlds.page?.items.length===0&&<p>{i18n.t("sessions:noWorlds")}</p>}
  {(worlds.loading||world.loading||models.loading||presets.loading)&&<Loading/>}
  {presets.replyCatalog.error&&<ErrorNotice message={presets.replyCatalog.error} onRetry={presets.replyCatalog.reload}/>}
  {error&&<ErrorNotice message={error}/>}{worlds.error&&<ErrorNotice message={worlds.error} onRetry={worlds.reload}/>}{world.error&&<ErrorNotice message={world.error} onRetry={world.reload}/>}{models.error&&<ErrorNotice message={models.error} onRetry={models.reload}/>}{presets.error&&<ErrorNotice message={presets.error} onRetry={presets.reload}/>}
 </Modal>;
}
