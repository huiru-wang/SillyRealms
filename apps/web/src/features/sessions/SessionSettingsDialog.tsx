import {useTranslation} from 'react-i18next';
import {i18n} from '../../i18n/instance.ts';
import {Button,IconButton} from '../../components/ui/Button';
import {Input,Textarea} from '../../components/ui/Field';
import {Select} from '../../components/ui/Select';
import {Range} from '../../components/ui/Range';
import React,{useEffect,useRef} from 'react';
import {X} from 'lucide-react';

type Option={id:string;name:string;modelId?:string};
type Props={
  replyPreset:string|null;replyPresets:Option[];onReplyPresetChange:(value:string|null)=>void;
  goal:string;onGoalChange:(value:string)=>void;
  title:string;preset:string;model:string;
  presets:Option[];models:Option[];
  fontSize:number;saving:boolean;error:string;disabled:boolean;canSave:boolean;
  onTitleChange:(value:string)=>void;onPresetChange:(value:string)=>void;onModelChange:(value:string)=>void;
  onFontSizeChange:(value:number)=>void;onCancel:()=>void;onSave:()=>void;
};
export function SessionSettingsDialog(props:Props){
  useTranslation();
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{
    const element=dialog.current;
    if(!element)return;
    element.showModal();
    return()=>{if(element.open)element.close();};
  },[]);
  return <dialog ref={dialog} className="host-settings-dialog" aria-labelledby="host-settings-title"
    onCancel={event=>{event.preventDefault();props.onCancel();}}
    onClick={event=>{if(event.target===event.currentTarget)props.onCancel();}}>
    <header className="host-settings-dialog-header">
      <div><span className="host-settings-eyebrow">SESSION</span><h2 id="host-settings-title">{i18n.t("sessions:settings")}</h2></div>
      <IconButton aria-label={i18n.t("sessions:closeSettings")} onClick={props.onCancel}><X size={17}/></IconButton>
    </header>
    <div className="host-settings-fields">
      <label>{i18n.t("sessions:title")}<Input value={props.title} onChange={event=>props.onTitleChange(event.target.value)} maxLength={120} disabled={props.disabled}/></label>
      <label>{i18n.t("sessions:apiModel")}<Select aria-label={i18n.t("sessions:apiModel")} value={props.model} onChange={event=>props.onModelChange(event.target.value)} disabled={props.disabled}><option value="">{i18n.t("sessions:selectModel")}</option>{props.models.map(item=><option value={item.id} key={item.id}>{item.name}{item.modelId?' · '+item.modelId:''}</option>)}</Select></label>
      <label>{i18n.t("sessions:narrativePreset")}<Select aria-label={i18n.t("sessions:narrativePreset")} value={props.preset} onChange={event=>props.onPresetChange(event.target.value)} disabled={props.disabled}><option value="">{i18n.t("sessions:selectPreset")}</option>{props.presets.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</Select></label>
      <label>{i18n.t("sessions:assistPreset")}
        <Select aria-label={i18n.t("sessions:assistPreset")} value={props.replyPreset??''} disabled={props.disabled} onChange={event=>props.onReplyPresetChange(event.target.value||null)}>
          <option value="">{i18n.t("sessions:followAppDefault")}</option>
          {props.replyPresets.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}
        </Select>
      </label>
      <label>{i18n.t("sessions:assistGoal")}<Textarea value={props.goal} maxLength={2000} disabled={props.disabled} onChange={event=>props.onGoalChange(event.target.value)}/></label>
    </div>
    <section className="host-reading-settings" aria-labelledby="host-reading-title">
      <label id="host-reading-title" htmlFor="host-reading-font-size">{i18n.t("sessions:fontSize")}</label>
      <Range id="host-reading-font-size" aria-labelledby="host-reading-title" disabled={props.disabled} min={13} max={21} step={1}
        value={props.fontSize} onChange={event=>props.onFontSizeChange(Number(event.target.value))}
        aria-valuetext={props.fontSize+" " + i18n.t("sessions:pixels")}/>
      <span className="host-reading-preview" style={{fontSize:props.fontSize+'px'}}>{i18n.t("sessions:fontPreview")}</span>
    </section>
    {props.error&&<p className="host-settings-error" role="alert">{props.error}</p>}
    <footer className="host-settings-dialog-footer">
      <Button type="button" variant="secondary" onClick={props.onCancel}>{i18n.t("common:cancel")}</Button>
      <Button type="button" variant="primary" disabled={!props.canSave} onClick={props.onSave}>{props.saving?i18n.t("sessions:saving"):i18n.t("sessions:saveSettings")}</Button>
    </footer>
  </dialog>;
}
