import React,{useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import {Check,ChevronRight,MonitorCog,ShieldCheck,SlidersHorizontal} from 'lucide-react';
import {api,json} from '../../api';
import {ErrorNotice,Header,Loading,useLoad} from '../../app/ui';

export function SettingsPage(){
 const settings=useLoad('v1/app-settings'),presets=useLoad('v1/presets?limit=100'),models=useLoad('v1/api-model-configs');
 const [defaultPreset,setDefaultPreset]=useState(''),[defaultModel,setDefaultModel]=useState('');
 const [theme,setTheme]=useState(()=>localStorage.getItem('sr-theme')??'light');
 const [density,setDensity]=useState(()=>localStorage.getItem('sr-density')??'comfortable');
 const [saving,setSaving]=useState(false),[saved,setSaved]=useState(''),[error,setError]=useState('');
 useEffect(()=>{if(settings.value?.item){setDefaultPreset(settings.value.item.defaultPresetId??'');setDefaultModel(settings.value.item.defaultApiModelConfigId??'');}},[settings.value]);
 const apply=(t:string,d:string)=>{setTheme(t);setDensity(d);document.documentElement.dataset.theme=t;document.documentElement.dataset.density=d;localStorage.setItem('sr-theme',t);localStorage.setItem('sr-density',d);};
 const save=async()=>{
  setSaved('');setError('');setSaving(true);
  try{await api('v1/app-settings',{method:'PATCH',body:json({defaultPresetId:defaultPreset||null,defaultApiModelConfigId:defaultModel||null})});await settings.reload();setSaved('默认配置已保存。仅影响之后导入的世界卡。');}
  catch(e){setError(e instanceof Error?e.message:String(e));}finally{setSaving(false);}
 };
 const canSave=!!settings.value;
 return <main className="page settings-page">
  <Header eyebrow="WORKSPACE SETTINGS" title="设置" description="管理应用默认配置和你的个人工作区外观。"/>
  {settings.error&&<ErrorNotice message={settings.error} onRetry={settings.reload}/>}
  {error&&<ErrorNotice message={error}/>}
  {saved&&<div className="preset-save-ok" role="status"><Check size={16}/>{saved}</div>}
  <div className="settings-stack">
   <section className="settings-group"><div className="settings-group-title"><span className="settings-group-icon"><SlidersHorizontal size={18}/></span><div><h2>默认运行配置</h2><p>导入世界卡时继承一次。修改这里不会改变现有世界和会话。</p></div></div>
     {!settings.value?<Loading text="读取配置…"/>:<div className="settings-rows">
       <label className="settings-row"><span><strong>默认预设</strong><small>决定提示词、上下文编排和生成策略。</small></span><select value={defaultPreset} onChange={e=>{setDefaultPreset(e.target.value);setSaved('');}}><option value="">未配置</option>{presets.value?.items?.map((p:any)=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
       <label className="settings-row"><span><strong>默认模型</strong><small>新导入世界卡将使用此 API 连接。</small></span><select value={defaultModel} onChange={e=>{setDefaultModel(e.target.value);setSaved('');}}><option value="">未配置</option>{models.value?.items?.map((m:any)=><option key={m.id} value={m.id}>{m.name} · {m.modelId}{!m.credentialConfigured?'（缺少密钥）':''}</option>)}</select></label>
       <div className="settings-row settings-row-action"><div><span className="settings-row-hint"><ShieldCheck size={16}/> 模型 API Key 由本地服务端安全管理。</span><Link to="/providers">管理模型连接 <ChevronRight size={15}/></Link></div><button className="button primary" disabled={saving||!canSave} onClick={()=>void save()}>{saving?'保存中…':'保存默认配置'}</button></div>
     </div>}
   </section>
   <section className="settings-group"><div className="settings-group-title"><span className="settings-group-icon"><MonitorCog size={18}/></span><div><h2>外观</h2><p>平台主题与列表密度，不影响创作者世界卡自定义界面。</p></div></div>
     <div className="settings-appearance"><p className="settings-label">颜色主题</p><div className="settings-theme-options">
       <button className={'settings-theme-choice '+(theme==='light'?'selected':'')} onClick={()=>apply('light',density)}><span className="settings-theme-swatch light"><i/><i/><i/></span><span>浅色<small>明亮 · 清晰</small></span>{theme==='light'&&<Check size={17}/>}</button>
       <button className={'settings-theme-choice '+(theme==='dark'?'selected':'')} onClick={()=>apply('dark',density)}><span className="settings-theme-swatch dark"><i/><i/><i/></span><span>深色<small>低光 · 沉浸</small></span>{theme==='dark'&&<Check size={17}/>}</button>
     </div>
     <p className="settings-label">界面密度</p><div className="segmented"><button className={density==='comfortable'?'active':''} onClick={()=>apply(theme,'comfortable')}>舒适</button><button className={density==='compact'?'active':''} onClick={()=>apply(theme,'compact')}>紧凑</button></div>
     </div>
   </section>
   <section className="settings-group about-note"><div><h2>SillyRealms</h2><p>本地优先的世界卡与多角色叙事工作台。世界、会话存于本机；无云端账户要求。</p></div><span>MVP · LOCAL FIRST</span></section>
  </div>
 </main>;
}
