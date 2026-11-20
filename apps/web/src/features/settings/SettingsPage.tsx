import {useEffect,useRef,useState} from 'react';
import {useOutletContext} from 'react-router-dom';
import {Check,MonitorCog,SlidersHorizontal} from 'lucide-react';
import {Panel} from '../../components/ui/Field';
import {Button} from '../../components/ui/Button';
import {Select} from '../../components/ui/Select';
import {PageHeader} from '../../components/ui/PageHeader';
import type {Theme} from '../../hooks/useTheme';
import {ErrorNotice,Loading} from '../../app/ui';
import {useManagement,type AppSettings} from '../../app/ManagementData';
import {usePagedResource} from '../../data';
import {usePresetStore} from '../presets/PresetStore';
import type {ModelConfig} from '../models/types';

export function SettingsPage(){
 const {theme,toggleTheme}=useOutletContext<{theme:Theme;toggleTheme:()=>void}>();
 const {settings,saveSettings,modelsRevision}=useManagement();
 const presets=usePresetStore(),models=usePagedResource<ModelConfig>('v1/api-model-configs?limit=100',modelsRevision,true);
 const [baseline,setBaseline]=useState<AppSettings|null>(null),[draft,setDraft]=useState<AppSettings|null>(null);
 const [saving,setSaving]=useState(false),[saved,setSaved]=useState(''),[error,setError]=useState('');const pending=useRef(false);
 const dirty=JSON.stringify(baseline)!==JSON.stringify(draft);
 useEffect(()=>{if(settings.value&&!dirty){setBaseline(settings.value.item);setDraft(settings.value.item);}},[settings.value,dirty]);
 const save=async()=>{
  if(!draft||!baseline||pending.current)return;
  const patch:Partial<AppSettings>={};
  if(draft.defaultPresetId!==baseline.defaultPresetId)patch.defaultPresetId=draft.defaultPresetId;
  if(draft.defaultApiModelConfigId!==baseline.defaultApiModelConfigId)patch.defaultApiModelConfigId=draft.defaultApiModelConfigId;
  if(!Object.keys(patch).length)return;
  pending.current=true;setSaving(true);setError('');setSaved('');
  try{const next=await saveSettings(patch);setBaseline(next);setDraft(next);setSaved('默认配置已保存。只影响之后导入的世界卡。');}
  catch(reason){setError(reason instanceof Error?reason.message:'保存失败');}
  finally{pending.current=false;setSaving(false);}
 };
 const set=(patch:Partial<AppSettings>)=>{setDraft(current=>current?{...current,...patch}:current);setSaved('');};
 return <main className="page settings-page">
  <PageHeader title="设置" description="管理界面外观与新世界卡的默认配置。"/>
  {settings.error&&<ErrorNotice message={settings.error} onRetry={settings.reload}/>}
  {error&&<ErrorNotice message={error}/>}{saved&&<div className="preset-save-ok" role="status"><Check size={16}/>{saved}</div>}
  <div className="settings-stack">
   <Panel className="settings-group"><div className="settings-group-title"><span className="settings-group-icon"><MonitorCog size={18}/></span><h2>外观</h2></div>
    <label className="settings-row settings-theme-row"><span><strong>主题</strong></span><Select aria-label="主题" value={theme} onChange={event=>{if(event.target.value!==theme)toggleTheme();}}><option value="light">浅色</option><option value="dark">深色</option></Select></label>
   </Panel>
   <Panel className="settings-group"><div className="settings-group-title"><span className="settings-group-icon"><SlidersHorizontal size={18}/></span><div><h2>默认配置</h2><p>导入世界卡时复制一次。修改或清空不会改变现有世界和会话。</p></div></div>
    {presets.error&&<ErrorNotice message={presets.error} onRetry={presets.reload}/>}{models.error&&<ErrorNotice message={models.error} onRetry={models.reload}/>}
    {!draft?(settings.loading?<Loading text="读取配置…"/>:null):<div className="settings-rows">
     <label className="settings-row"><span><strong>默认预设</strong></span><Select aria-label="默认预设" disabled={saving} value={draft.defaultPresetId??''} onChange={event=>set({defaultPresetId:event.target.value||null})}>
      <option value="">未设置</option>{draft.defaultPresetId&&!presets.presets.some(p=>p.id===draft.defaultPresetId)&&<option value={draft.defaultPresetId}>当前预设（列表尚未加载）</option>}{presets.presets.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
     </Select></label>
     <label className="settings-row"><span><strong>默认模型</strong></span><Select aria-label="默认模型" disabled={saving} value={draft.defaultApiModelConfigId??''} onChange={event=>set({defaultApiModelConfigId:event.target.value||null})}>
      <option value="">未设置</option>{draft.defaultApiModelConfigId&&!models.page?.items.some(m=>m.id===draft.defaultApiModelConfigId)&&<option value={draft.defaultApiModelConfigId}>当前模型（列表尚未加载）</option>}{models.page?.items.map(m=><option key={m.id} value={m.id}>{m.name} · {m.modelId}</option>)}
     </Select></label>
     <div className="settings-row settings-row-action"><Button variant="primary" loading={saving} disabled={!dirty} onClick={()=>void save()}>保存默认配置</Button></div>
    </div>}
   </Panel>
  </div>
 </main>;
}
