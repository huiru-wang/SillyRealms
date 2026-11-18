import {Button} from '../../components/ui/Button';
import {Input,Textarea} from '../../components/ui/Field';
import {Select} from '../../components/ui/Select';
import React,{useEffect,useRef} from 'react';
import {X} from 'lucide-react';

export type CapabilityView={
  effective:{state_update:{enabled:boolean};action_suggestions:{enabled:boolean}};
};
type Option={id:string;name:string;modelId?:string};
type Props={
  title:string;preset:string;model:string;
  capabilities:CapabilityView|null;capabilitiesLoading:boolean;
  presets:Option[];models:Option[];
  fontSize:number;saving:boolean;error:string;disabled:boolean;canSave:boolean;
  onTitleChange:(value:string)=>void;onPresetChange:(value:string)=>void;onModelChange:(value:string)=>void;
  onFontSizeChange:(value:number)=>void;onCancel:()=>void;onSave:()=>void;
};
export function SessionSettingsDialog(props:Props){
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
      <div><span className="host-settings-eyebrow">SESSION</span><h2 id="host-settings-title">会话设置</h2></div>
      <button type="button" className="host-settings-close" aria-label="关闭会话设置" onClick={props.onCancel}><X size={17}/></button>
    </header>
    <div className="host-settings-fields">
      <label>会话标题<Input value={props.title} onChange={event=>props.onTitleChange(event.target.value)} maxLength={120}/></label>
      <label>预设<Select aria-label="预设" value={props.preset} onChange={event=>props.onPresetChange(event.target.value)} disabled={props.disabled}><option value="">请选择预设</option>{props.presets.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</Select></label>
      <label>API 模型<Select aria-label="API 模型" value={props.model} onChange={event=>props.onModelChange(event.target.value)} disabled={props.disabled}><option value="">请选择模型</option>{props.models.map(item=><option value={item.id} key={item.id}>{item.name}{item.modelId?' · '+item.modelId:''}</option>)}</Select></label>
    </div>
    <section className="host-capability-settings" aria-labelledby="host-capabilities-title">
      <h3 id="host-capabilities-title">预设能力</h3>
      <p>世界状态与行动建议由绑定的预设节点控制。更改请前往预设配置。</p>
      {props.capabilitiesLoading?<p role="status">正在读取…</p>:props.capabilities?<p>当前预设：世界状态{props.capabilities.effective.state_update.enabled?'开启':'关闭'}，行动建议{props.capabilities.effective.action_suggestions.enabled?'开启':'关闭'}。</p>:<p>能力设置暂不可用，请关闭后重试。</p>}
    </section>
    <section className="host-reading-settings" aria-labelledby="host-reading-title">
      <div className="host-reading-heading">
        <div><strong id="host-reading-title">阅读字体大小</strong><small>只调整故事正文，不影响世界卡原始内容</small></div>
        <output htmlFor="host-reading-font-size">{props.fontSize}px</output>
      </div>
      <input id="host-reading-font-size" className="host-reading-slider" type="range" min={13} max={21} step={1}
        value={props.fontSize} onChange={event=>props.onFontSizeChange(Number(event.target.value))}
        aria-valuetext={props.fontSize+' 像素'}/>
      <div className="host-reading-range"><span>较小 · 13px</span><span>较大 · 21px</span></div>
      <div className="host-reading-preview" style={{fontSize:props.fontSize+'px'}}>夜色渐深，庄园大厅里的烛火轻轻摇曳。</div>
    </section>
    {props.error&&<p className="host-settings-error" role="alert">{props.error}</p>}
    <footer className="host-settings-dialog-footer">
      <Button type="button" variant="secondary" onClick={props.onCancel}>取消</Button>
      <Button type="button" variant="primary" disabled={!props.canSave} onClick={props.onSave}>{props.saving?'保存中…':'保存设置'}</Button>
    </footer>
  </dialog>;
}
