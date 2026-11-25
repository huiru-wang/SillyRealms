import {useTranslation} from 'react-i18next';
import {useEffect,useRef,useState} from 'react';
import {Button} from '../../components/ui/Button';
import {Input,Textarea} from '../../components/ui/Field';
import {Select} from '../../components/ui/Select';
import {Switch} from '../../components/ui/Switch';
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
const draftOf=(world:WorldDetail)=>({name:world.name,tags:world.tags.join('，'),defaultPresetId:world.defaultPresetId??'',defaultReplyAssistPresetId:world.defaultReplyAssistPresetId??'',defaultApiModelConfigId:world.defaultApiModelConfigId??'',coverMosaicEnabled:world.coverMosaicEnabled});
export function WorldMetadataForm(props:Props){
  return <WorldForm {...props} kind="metadata"/>;}
export function WorldDefaultsForm(props:Props){
  return <WorldForm {...props} kind="defaults"/>;}
function WorldForm({world,onSaved,kind}:Props&{kind:'metadata'|'defaults'}){
  const {t} = useTranslation('worlds');
 const [baseline,setBaseline]=useState(world),[draft,setDraft]=useState(()=>draftOf(world)),[busy,setBusy]=useState(false),[error,setError]=useState<Error|string>(''),[conflict,setConflict]=useState(false),[reloadConfirm,setReloadConfirm]=useState(false),[saved,setSaved]=useState(false);
 const pending=useRef(false),dirty=JSON.stringify(draft)!==JSON.stringify(draftOf(baseline));
 useEffect(()=>{if(!dirty){setBaseline(world);setDraft(draftOf(world));}},[world,dirty]);
 useEffect(()=>{if(!dirty)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty]);
 const change=(value:Partial<typeof draft>)=>{setDraft(current=>({...current,...value}));setSaved(false);};
 async function save(){
  if(pending.current||!dirty)return;
  const patch:WorldPatch={};
  if(kind==='metadata'){
   if(!draft.name.trim()){setError(t('enterAWorldName'));return;}
   if(draft.name.trim()!==baseline.name)patch.name=draft.name.trim();
   const tags=parseTags(draft.tags);if(JSON.stringify(tags)!==JSON.stringify(baseline.tags))patch.tags=tags;
  }else{
   if(draft.coverMosaicEnabled!==baseline.coverMosaicEnabled)patch.coverMosaicEnabled=draft.coverMosaicEnabled;
   if((draft.defaultPresetId||null)!==baseline.defaultPresetId)patch.defaultPresetId=draft.defaultPresetId||null;
   if((draft.defaultReplyAssistPresetId||null)!==baseline.defaultReplyAssistPresetId)patch.defaultReplyAssistPresetId=draft.defaultReplyAssistPresetId||null;
   if((draft.defaultApiModelConfigId||null)!==baseline.defaultApiModelConfigId)patch.defaultApiModelConfigId=draft.defaultApiModelConfigId||null;
  }
  if(!Object.keys(patch).length){setDraft(draftOf(baseline));return;}
  pending.current=true;setBusy(true);setError('');setSaved(false);
  try{const {item}=await api<{item:WorldDetail}>('v1/worlds/'+encodeURIComponent(world.id),{method:'PATCH',body:json({...patch,expectedRevision:baseline.revision})});setBaseline(item);setDraft(draftOf(item));setConflict(false);onSaved(item);setSaved(true);}
  catch(reason){setError(reason instanceof Error?reason:t('couldNotSave'));if(reason instanceof ApiError&&reason.errorCode==='WORLD_REVISION_CONFLICT')setConflict(true);}
  finally{pending.current=false;setBusy(false);}
 }
 async function reload(){
  if(pending.current)return;pending.current=true;setBusy(true);setError('');
  try{const {item}=await api<{item:WorldDetail}>('v1/worlds/'+encodeURIComponent(world.id));setBaseline(item);setDraft(draftOf(item));onSaved(item);setConflict(false);setReloadConfirm(false);}
  catch(reason){setError(reason instanceof Error?reason:t('couldNotLoad'));}
  finally{pending.current=false;setBusy(false);}
 }
 return <div className="business-form">
  {kind==='metadata'?<div className="editor-form">
   <label>{t('worldName')}<Input value={draft.name} disabled={busy} onChange={e=>change({name:e.target.value})}/></label>
   <label>{t('tags')}<Textarea value={draft.tags} disabled={busy} onChange={e=>change({tags:e.target.value})} rows={2} placeholder={t('separateWithCommasOrLineBreaks')}/></label>
  </div>:<>
   <div className={styles.displaySetting}><label htmlFor="world-cover-mosaic">{t('coverMosaic')}</label><Switch id="world-cover-mosaic" checked={draft.coverMosaicEnabled} disabled={busy} label={t('coverMosaic')} onChange={coverMosaicEnabled=>change({coverMosaicEnabled})}/></div>
   <DefaultsFields draft={draft} change={change} busy={busy}/>
  </>}
  {error&&<ErrorNotice message={error}/>}
  <div className="actions"><Button variant="primary" loading={busy} disabled={!dirty} onClick={()=>void save()}>{t(kind==='metadata'?'worlds:saveMetadata':'worlds:saveConfiguration')}</Button>{dirty&&<Button disabled={busy} variant="ghost" onClick={()=>setReloadConfirm(true)}>{t('discardAndReload')}</Button>}{conflict&&!dirty&&<Button onClick={()=>setReloadConfirm(true)}>{t('reload')}</Button>}</div>
  {saved&&<p role="status">{t('saved')}</p>}
  {reloadConfirm&&<Modal title={t('reloadWorldConfiguration')} onBeforeClose={()=>!pending.current} onClose={()=>setReloadConfirm(false)} footer={<><Button disabled={busy} onClick={()=>setReloadConfirm(false)}>{t('keepEditing')}</Button><Button variant="primary" loading={busy} onClick={()=>void reload()}>{t('discardChangesAndLoad')}</Button></>}><p>{t('discardLocalChangesToThisFormAnd')}</p>{error&&<ErrorNotice message={error}/>}</Modal>}
 </div>;
}
function DefaultsFields({draft,change,busy}:{draft:ReturnType<typeof draftOf>;change:(value:Partial<ReturnType<typeof draftOf>>)=>void;busy:boolean}){
  const {t} = useTranslation('worlds');
 const presets=usePresetStore(),{modelsRevision}=useManagement();
 const models=usePagedResource<ModelConfig>('v1/api-model-configs?limit=100',modelsRevision,true);
 return <><div className="editor-form">
  <label>{t('sessions:narrativePreset')}<Select aria-label={t('worldDefaultPreset')} value={draft.defaultPresetId} disabled={busy} onChange={e=>change({defaultPresetId:e.target.value})}><option value="">{t('notSet')}</option>{draft.defaultPresetId&&!presets.presets.some(p=>p.id===draft.defaultPresetId)&&<option value={draft.defaultPresetId}>{t('currentPresetListNotLoaded')}</option>}{presets.presets.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Select></label>
  <label>{t('model')}<Select aria-label={t('worldDefaultModel')} value={draft.defaultApiModelConfigId} disabled={busy} onChange={e=>change({defaultApiModelConfigId:e.target.value})}><option value="">{t('notSet')}</option>{draft.defaultApiModelConfigId&&!models.page?.items.some(m=>m.id===draft.defaultApiModelConfigId)&&<option value={draft.defaultApiModelConfigId}>{t('currentModelListNotLoaded')}</option>}{models.page?.items.map(m=><option key={m.id} value={m.id}>{m.name}{m.credentialStatus==='configured'?'':m.credentialStatus==='missing'?t('noSavedCredentials'):t('credentialStorageUnavailable')}</option>)}</Select></label>
  <label>{t('sessions:assistPreset')}<Select aria-label={t('sessions:assistPreset')} value={draft.defaultReplyAssistPresetId} disabled={busy} onChange={e=>change({defaultReplyAssistPresetId:e.target.value})}><option value="">{t('sessions:followAppDefault')}</option>{draft.defaultReplyAssistPresetId&&!presets.replyPresets.some(p=>p.id===draft.defaultReplyAssistPresetId)&&<option value={draft.defaultReplyAssistPresetId}>{t('currentPresetListNotLoaded')}</option>}{presets.replyPresets.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Select></label>
 </div>{presets.error&&<ErrorNotice message={presets.error} onRetry={presets.reload}/>}{presets.replyCatalog.error&&<ErrorNotice message={presets.replyCatalog.error} onRetry={presets.replyCatalog.reload}/>}{models.error&&<ErrorNotice message={models.error} onRetry={models.reload}/>}</>;
}
