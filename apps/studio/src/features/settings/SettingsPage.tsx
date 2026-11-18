import {Panel} from '../../components/ui/Field';
import {Button} from '../../components/ui/Button';
import {Select} from '../../components/ui/Select';
import React,{useEffect,useState} from 'react';
import {useOutletContext} from 'react-router-dom';
import {Check,MonitorCog,SlidersHorizontal} from 'lucide-react';
import type {Theme} from '../../hooks/useTheme';
import {api,json} from '../../api';
import {ErrorNotice,Header,Loading,useLoad} from '../../app/ui';

export function SettingsPage(){
 const {theme,toggleTheme}=useOutletContext<{theme:Theme;toggleTheme:()=>void}>();
 const settings=useLoad('v1/app-settings'),presets=useLoad('v1/presets?limit=100',true),models=useLoad('v1/api-model-configs');
 const [defaultPreset,setDefaultPreset]=useState(''),[defaultModel,setDefaultModel]=useState('');
 const [saving,setSaving]=useState(false),[saved,setSaved]=useState(''),[error,setError]=useState('');
 useEffect(()=>{if(settings.value?.item){setDefaultPreset(settings.value.item.defaultPresetId??'');setDefaultModel(settings.value.item.defaultApiModelConfigId??'');}},[settings.value]);
 const save=async()=>{
  if(!canSave){setError('请选择有效的默认预设和默认模型。');return;}
  setSaved('');setError('');setSaving(true);
  try{await api('v1/app-settings',{method:'PATCH',body:json({defaultPresetId:defaultPreset,defaultApiModelConfigId:defaultModel})});await settings.reload();window.dispatchEvent(new Event('sr:settings-changed'));setSaved('默认配置已保存。仅影响之后导入的世界卡。');}
  catch(e){setError(e instanceof Error?e.message:String(e));}finally{setSaving(false);}
 };
 const canSave=!!settings.value&&!!presets.value?.items?.some((p:any)=>p.id===defaultPreset)&&!!models.value?.items?.some((m:any)=>m.id===defaultModel);
 return <main className="page settings-page">
  <Header eyebrow="WORKSPACE SETTINGS" title="设置" description="管理界面外观与新世界卡的默认运行配置。"/>
  {settings.error&&<ErrorNotice message={settings.error} onRetry={settings.reload}/>}
  {error&&<ErrorNotice message={error}/>}{presets.error&&<ErrorNotice message={presets.error} onRetry={presets.reload}/>}{models.error&&<ErrorNotice message={models.error} onRetry={models.reload}/>}
  {saved&&<div className="preset-save-ok" role="status"><Check size={16}/>{saved}</div>}
  <div className="settings-stack">
   <Panel className="settings-group"><div className="settings-group-title"><span className="settings-group-icon"><MonitorCog size={18}/></span><div><h2>外观</h2></div></div>
    <label className="settings-row settings-theme-row"><span><strong>主题</strong></span><Select aria-label="主题" value={theme} onChange={e=>{if(e.target.value!==theme)toggleTheme();}}><option value="light">浅色</option><option value="dark">深色</option></Select></label>
   </Panel>
   <Panel className="settings-group"><div className="settings-group-title"><span className="settings-group-icon"><SlidersHorizontal size={18}/></span><div><h2>默认运行配置</h2><p>导入世界卡时继承一次。修改这里不会改变现有世界和会话。</p></div></div>
     {!settings.value?<Loading text="读取配置…"/>:<div className="settings-rows">
       <label className="settings-row"><span><strong>默认预设</strong><small>决定提示词、上下文编排和生成策略。</small></span><Select required aria-label="默认预设" disabled={!presets.value?.items?.length} value={defaultPreset} onChange={e=>{setDefaultPreset(e.target.value);setSaved('');}}><option value="" disabled>请选择预设</option>{presets.value?.items?.map((p:any)=><option key={p.id} value={p.id}>{p.name}</option>)}</Select></label>
       <label className="settings-row"><span><strong>默认模型</strong><small>新导入世界卡将使用此 API 连接。</small></span><Select required aria-label="默认模型" disabled={!models.value?.items?.length} value={defaultModel} onChange={e=>{setDefaultModel(e.target.value);setSaved('');}}><option value="" disabled>请选择模型</option>{models.value?.items?.map((m:any)=><option key={m.id} value={m.id}>{m.name} · {m.modelId}{!m.credentialConfigured?'（缺少密钥）':''}</option>)}</Select></label>
       <div className="settings-row settings-row-action"><Button variant="primary" loading={saving} disabled={!canSave} onClick={()=>void save()}>{saving?'保存中…':'保存默认配置'}</Button></div>
     </div>}
   </Panel>
  </div>
 </main>;
}
