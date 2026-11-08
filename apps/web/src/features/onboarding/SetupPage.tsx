import React,{useEffect,useState} from 'react';
import {Link,useNavigate} from 'react-router-dom';
import {ArrowRight,Check,CheckCircle2,KeyRound,Layers3,ShieldCheck,Sparkles} from 'lucide-react';
import {api,json} from '../../api';
import {ErrorNotice,Loading,useLoad} from '../../app/ui';

export function SetupPage(){
 const navigate=useNavigate();
 const defaults=useLoad('v1/app-settings'),configs=useLoad('v1/api-model-configs'),catalog=useLoad('v1/providers/models'),presets=useLoad('v1/presets?limit=100');
 const [provider,setProvider]=useState(''),[model,setModel]=useState(''),[key,setKey]=useState(''),[name,setName]=useState('');
 const [existing,setExisting]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const providers:Array<{providerId:string;models:Array<{id:string;name:string}>}>=catalog.value?.providers??[];
 const models=providers.find(x=>x.providerId===provider)?.models??[];
 const currentConfigs:any[]=configs.value?.items??[];
 const preferredPresetId:string|undefined=defaults.value?.item?.defaultPresetId??presets.value?.items?.[0]?.id;
 useEffect(()=>{if(!provider&&providers.length){const preferred=providers.find(p=>p.providerId==='deepseek')??providers.find(p=>p.providerId==='openai')??providers[0];setProvider(preferred.providerId);setModel(preferred.models[0]?.id??'');}},[catalog.value]);
 useEffect(()=>{if(currentConfigs.length&&!existing)setExisting(currentConfigs.find((c:any)=>c.credentialConfigured)?.id??currentConfigs[0].id);},[configs.value]);
 const complete=!!defaults.value?.item?.defaultPresetId&&!!defaults.value?.item?.defaultApiModelConfigId&&!!currentConfigs.find(c=>c.id===defaults.value.item.defaultApiModelConfigId&&c.credentialConfigured);
 const save=async()=>{
   setBusy(true);setError('');
   try{
     if(!preferredPresetId)throw Error('请先创建或导入一个叙事预设。');
     if(currentConfigs.length){
       if(!existing)throw Error('请选择一个已配置的模型。');
       const chosen=currentConfigs.find(c=>c.id===existing);
       if(!chosen?.credentialConfigured)throw Error('此模型缺少有效凭据，请前往模型连接更新。');
       await api('v1/app-settings',{method:'PATCH',body:json({defaultPresetId:preferredPresetId,defaultApiModelConfigId:existing})});
     }else{
       if(!provider||!model||!key.trim())throw Error('请选择服务商和模型，并填写 API Key。');
       const created=await api('v1/api-model-configs',{method:'POST',body:json({name:name.trim()||model,providerId:provider,modelId:model,apiKey:key.trim()})});
       await api('v1/app-settings',{method:'PATCH',body:json({defaultPresetId:preferredPresetId,defaultApiModelConfigId:created.item.id})});
     }
     navigate('/worlds',{replace:true});
   }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
 };
 return <main className="setup-shell">
   <div className="setup-intro"><span className="setup-symbol"><Layers3 size={28}/></span><div className="eyebrow">WELCOME TO SILLYREALMS</div><h1>让故事从这里开始。</h1><p>连接一次模型，就可以导入世界卡、选择角色并开始对话。复杂配置，留到真正需要它的时候。</p>
     <div className="setup-perks"><div><CheckCircle2 size={17}/> 内置通用叙事预设</div><div><CheckCircle2 size={17}/> 世界卡自动继承配置</div><div><CheckCircle2 size={17}/> 会话中随时更换模型</div></div>
   </div>
   <section className="setup-card">
     <div className="setup-step">STEP 01 / 01</div><h2>{complete?'运行环境已就绪':currentConfigs.length?'完善运行配置':'连接你的 AI 模型'}</h2><p>{complete?'你已经可以开始探索世界。':currentConfigs.length?'使用现有模型连接和通用叙事预设，无需重复输入 API Key。':'填写模型连接信息，后续导入的世界卡将自动使用它。'}</p>
     {!defaults.value||!configs.value||!catalog.value||!presets.value?<Loading text="正在检测运行环境…"/>:complete?<div className="setup-ready"><Check size={19}/><span>默认预设和 API 模型已配置</span></div>:currentConfigs.length?
       <div className="setup-form"><label>使用现有模型<select value={existing} onChange={e=>setExisting(e.target.value)}>{currentConfigs.map(c=><option key={c.id} value={c.id}>{c.name} · {c.modelId}{!c.credentialConfigured?'（缺少密钥）':''}</option>)}</select></label><p className="setup-hint"><ShieldCheck size={15}/> 已保存的 API Key 不会在此页面重新显示。</p>{!currentConfigs.some(c=>c.credentialConfigured)&&<p className="setup-hint">现有连接缺少凭据。<Link to="/providers">前往模型连接补充 API Key <ArrowRight size={14}/></Link></p>}</div>:
       <div className="setup-form"><label>模型服务商<select value={provider} onChange={e=>{const p=providers.find(x=>x.providerId===e.target.value);setProvider(e.target.value);setModel(p?.models[0]?.id??'');}}><option value="">选择服务商</option>{providers.map(p=><option key={p.providerId} value={p.providerId}>{p.providerId}</option>)}</select></label>
         <label>模型<select value={model} onChange={e=>setModel(e.target.value)}><option value="">选择模型</option>{models.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
         <label>连接名称（可选）<input value={name} onChange={e=>setName(e.target.value)} placeholder="例如：我的叙事模型"/></label>
         <label>API Key<input type="password" autoComplete="off" value={key} onChange={e=>setKey(e.target.value)} placeholder="填写模型服务商提供的 API Key"/></label>
         <p className="setup-hint"><KeyRound size={15}/> 凭据保存在本机安全存储中，不需要每次输入。</p>
       </div>}
     {presets.value&&!preferredPresetId&&<p className="setup-hint">尚无可用预设。<Link to="/presets/new">先创建叙事预设 <ArrowRight size={14}/></Link></p>}
     {(error||defaults.error||configs.error||catalog.error||presets.error)&&<ErrorNotice message={error||defaults.error||configs.error||catalog.error||presets.error}/>}
     {complete?<Link className="button primary setup-submit" to="/worlds">进入世界库 <ArrowRight size={17}/></Link>:<button className="button primary setup-submit" disabled={busy||!defaults.value||!catalog.value||!presets.value} onClick={()=>void save()}>{busy?'正在保存…':'保存并进入世界库'} <ArrowRight size={17}/></button>}
     <div className="setup-bottom"><span>无需预先配置 Prompt 或世界状态</span><Link to="/worlds">先浏览世界库</Link></div>
   </section>
 </main>;
}
