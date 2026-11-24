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

type Props={session:Session;disabled:boolean;fontSize:number;onFontSize:(size:number)=>void;onClose:()=>void;onSaved:(session:Session)=>void};
export function SessionConfiguration(props:Props){
  useTranslation();
  const {session}=props,{modelsRevision,refreshSessions}=useManagement(),presets=usePresetStore();
  const models=usePagedResource<ModelConfig>('v1/api-model-configs?limit=100',modelsRevision,true);
  const [title,setTitle]=useState(session.title??''),[preset,setPreset]=useState(session.presetId),[model,setModel]=useState(session.apiModelConfigId);
  const [font,setFont]=useState(props.fontSize),[saving,setSaving]=useState(false),[error,setError]=useState('');
  const originalFont=useRef(props.fontSize),pending=useRef(false);
  const save=async()=>{
    if(pending.current)return;
    const patch:SessionPatch={};
    if((title.trim()||null)!==session.title)patch.title=title.trim()||null;
    if(preset!==session.presetId)patch.presetId=preset;
    if(model!==session.apiModelConfigId)patch.apiModelConfigId=model;
    if(Object.keys(patch).length&&props.disabled){setError('sessions:waitToConfigure');return;}
    if(!preset||!model){setError('sessions:choosePresetAndModel');return;}
    pending.current=true;setSaving(true);setError('');
    try{
      if(Object.keys(patch).length){const updated=await updateSession(session.id,patch);props.onSaved(updated);refreshSessions();}
      props.onFontSize(font);
      try{localStorage.setItem('sr:session:'+session.id+':reading-font-size',String(font));}catch{/* The selected appearance remains effective for this page. */}
      props.onClose();
    }catch(reason){setError(errorKey(reason,"sessions:settingsSaveFailed"));}
    finally{pending.current=false;setSaving(false);}
  };
  const presetOptions=presets.presets.map(item=>({id:item.id,name:item.name}));
  if(!presetOptions.some(item=>item.id===session.presetId))presetOptions.unshift({id:session.presetId,name:i18n.t("sessions:currentPreset")});
  const modelOptions=(models.page?.items??[]).map(item=>({id:item.id,name:item.name,modelId:item.modelId}));
  if(!modelOptions.some(item=>item.id===session.apiModelConfigId))modelOptions.unshift({id:session.apiModelConfigId,name:i18n.t("sessions:currentModel"),modelId:''});
  return <SessionSettingsDialog title={title} preset={preset} model={model} presets={presetOptions} models={modelOptions}
    fontSize={font} saving={saving} error={errorMessage(error||presets.error||models.error)} disabled={saving||props.disabled} canSave={!saving&&!!preset&&!!model}
    onTitleChange={setTitle} onPresetChange={setPreset} onModelChange={setModel}
    onFontSizeChange={value=>{setFont(value);props.onFontSize(value);}}
    onCancel={()=>{if(pending.current)return;props.onFontSize(originalFont.current);props.onClose();}}
    onSave={()=>void save()}/>;
}
