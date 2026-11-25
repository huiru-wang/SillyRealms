import {errorKey,errorMessage} from '../../i18n/errors.ts';
import {useTranslation} from 'react-i18next';
import {i18n} from '../../i18n/instance.ts';
import {useRef,useState} from 'react';
import {useManagement} from '../../app/ManagementData';
import {usePresetStore} from '../presets/PresetStore';
import {usePagedResource} from '../../data';
import type {ModelConfig} from '../models/types';
import type {Session} from './types';
import {SessionSettingsDialog} from './SessionSettingsDialog';
import {updateSession,type SessionPatch} from './client';

type Props={session:Session;disabled:boolean;onFontSize:(size:number)=>void;onClose:()=>void;onSaved:(session:Session)=>void};
export function SessionConfiguration(props:Props){
  useTranslation();
  const {session}=props,{modelsRevision,refreshSessions}=useManagement(),presets=usePresetStore();
  const models=usePagedResource<ModelConfig>('v1/api-model-configs?limit=100',modelsRevision,true);
  const [baseline]=useState(session);
  const config=baseline.runtimeConfig;
  const [replyPreset,setReplyPreset]=useState(config.replyAssistPresetId);
  const [goal,setGoal]=useState(config.replyAssistGoal);
  const [title,setTitle]=useState(session.title??''),[preset,setPreset]=useState(config.narrativePresetId),[model,setModel]=useState(config.apiModelConfigId);
  const [font,setFont]=useState(config.fontSize),[saving,setSaving]=useState(false),[error,setError]=useState('');
  const pending=useRef(false);
  const save=async()=>{
    if(pending.current)return;
    const patch:SessionPatch={};
    const changes:Partial<Session['runtimeConfig']>={};
    if(replyPreset!==config.replyAssistPresetId)changes.replyAssistPresetId=replyPreset;
    if(goal!==config.replyAssistGoal)changes.replyAssistGoal=goal;
    if((title.trim()||null)!==baseline.title)patch.title=title.trim()||null;
    if(preset!==config.narrativePresetId)changes.narrativePresetId=preset;
    if(model!==config.apiModelConfigId)changes.apiModelConfigId=model;
    if(font!==config.fontSize)changes.fontSize=font;
    if(Object.keys(changes).length)patch.runtimeConfig=changes;
    if(Object.keys(patch).length&&props.disabled){setError('sessions:waitToConfigure');return;}
    if(!preset||!model){setError('sessions:choosePresetAndModel');return;}
    pending.current=true;setSaving(true);setError('');
    try{
      if(Object.keys(patch).length){const updated=await updateSession(session.id,patch);props.onSaved(updated);refreshSessions();}
      props.onClose();
    }catch(reason){setError(errorKey(reason,"sessions:settingsSaveFailed"));}
    finally{pending.current=false;setSaving(false);}
  };
  const presetOptions=presets.presets.map(item=>({id:item.id,name:item.name}));
  if(!presetOptions.some(item=>item.id===config.narrativePresetId))presetOptions.unshift({id:config.narrativePresetId,name:i18n.t("sessions:currentPreset")});
  const replyOptions=presets.replyPresets.map(item=>({id:item.id,name:item.name}));
  if(config.replyAssistPresetId&&!replyOptions.some(item=>item.id===config.replyAssistPresetId)){
    replyOptions.unshift({id:config.replyAssistPresetId,name:i18n.t("sessions:currentPreset")});
  }
  const modelOptions=(models.page?.items??[]).map(item=>({id:item.id,name:item.name,modelId:item.modelId}));
  if(!modelOptions.some(item=>item.id===config.apiModelConfigId))modelOptions.unshift({id:config.apiModelConfigId,name:i18n.t("sessions:currentModel"),modelId:''});
  return <SessionSettingsDialog goal={goal} onGoalChange={setGoal} title={title} preset={preset} model={model} presets={presetOptions} models={modelOptions}
    replyPreset={replyPreset} replyPresets={replyOptions} onReplyPresetChange={setReplyPreset}
    fontSize={font} saving={saving} error={errorMessage(error||presets.error||presets.replyCatalog.error||models.error)} disabled={saving||props.disabled} canSave={!saving&&!props.disabled&&!!preset&&!!model}
    onTitleChange={setTitle} onPresetChange={setPreset} onModelChange={setModel}
    onFontSizeChange={value=>{setFont(value);props.onFontSize(value);}}
    onCancel={()=>{if(pending.current)return;props.onClose();}}
    onSave={()=>void save()}/>;
}
