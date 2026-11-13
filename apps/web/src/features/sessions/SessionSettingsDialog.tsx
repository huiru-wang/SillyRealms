import React,{useEffect,useRef} from 'react';
import {X} from 'lucide-react';

export type CapabilityView={
  activeRun?:{capabilities?:{stateUpdate:{enabled:boolean};actionSuggestions:{enabled:boolean;count:number}}}|null;
  revision:number;overrides:{state_update?:boolean;action_suggestions?:boolean};
  effective:{state_update:{enabled:boolean};action_suggestions:{enabled:boolean;count:number}};
  sources:{state_update:string;action_suggestions:string};
};
export type CapabilityOverrides={state_update:boolean|null;action_suggestions:boolean|null};
type Option={id:string;name:string;modelId?:string};
type Props={
  title:string;preset:string;model:string;mode:'direct'|'agent';
  capabilities:CapabilityView|null;overrides:CapabilityOverrides;capabilitiesLoading:boolean;
  onModeChange:(value:'direct'|'agent')=>void;onOverridesChange:(value:CapabilityOverrides)=>void;
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
      <label>会话标题<input value={props.title} onChange={event=>props.onTitleChange(event.target.value)} maxLength={120}/></label>
      <label>预设<select value={props.preset} onChange={event=>props.onPresetChange(event.target.value)} disabled={props.disabled}><option value="">请选择预设</option>{props.presets.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
      <label>API 模型<select value={props.model} onChange={event=>props.onModelChange(event.target.value)} disabled={props.disabled}><option value="">请选择模型</option>{props.models.map(item=><option value={item.id} key={item.id}>{item.name}{item.modelId?' · '+item.modelId:''}</option>)}</select></label>
      <label>执行模式<select value={props.mode} disabled={props.disabled} onChange={event=>props.onModeChange(event.target.value as 'direct'|'agent')}><option value="direct">Direct · 直接叙事</option><option value="agent">Agent · 工具循环</option></select><small>{props.disabled?'本轮结束后可切换模式。':'新会话使用 Direct；切换只影响下一轮生成。'}</small></label>
    </div>
    <section className="host-capability-settings" aria-labelledby="host-capabilities-title">
      <h3 id="host-capabilities-title">Direct 叙事能力</h3>
      <p>{props.mode==='agent'?'当前为 Agent 模式，以下设置不参与工具循环。':'能力开关只覆盖本会话；生成中修改将在下一轮生效。'}</p>
      {props.capabilities?.activeRun?.capabilities&&<p className="host-current-capabilities">本轮使用：状态更新{props.capabilities.activeRun.capabilities.stateUpdate.enabled?'开启':'关闭'}，行动建议{props.capabilities.activeRun.capabilities.actionSuggestions.enabled?'开启':'关闭'}；以下更改只影响下一轮。</p>}
      {props.capabilitiesLoading?<p role="status">正在读取能力设置…</p>:!props.capabilities?<p>能力设置暂不可用，请关闭后重试。</p>:
        (['state_update','action_suggestions'] as const).map(name=><label key={name}>
          {name==='state_update'?'更新故事状态':'生成行动建议'}
          <select value={props.overrides[name]===null?'inherit':String(props.overrides[name])} disabled={props.mode==='agent'||props.saving}
            onChange={event=>props.onOverridesChange({...props.overrides,[name]:event.target.value==='inherit'?null:event.target.value==='true'})}>
            <option value="inherit">继承预设</option><option value="true">开启</option><option value="false">关闭</option>
          </select>
          <small>已保存的有效设置：{props.capabilities!.effective[name].enabled?'开启':'关闭'} · 来源：{({session:'本会话',preset:'预设',platform:'平台默认'} as Record<string,string>)[props.capabilities!.sources[name]]??'预设'}</small>
        </label>)}
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
      <button type="button" className="button secondary" onClick={props.onCancel}>取消</button>
      <button type="button" className="button primary" disabled={!props.canSave} onClick={props.onSave}>{props.saving?'保存中…':'保存设置'}</button>
    </footer>
  </dialog>;
}
