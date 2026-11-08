import React,{useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import {ArrowRight,Check,KeyRound,Plus,Settings2,ShieldCheck,Trash2,Wifi} from 'lucide-react';
import {api,json} from '../../api';
import {Empty,ErrorNotice,Header,Loading,useLoad} from '../../app/ui';

type ModelConfig={id:string;name:string;providerId:string;modelId:string;credentialConfigured:boolean};
type Draft={id?:string;name:string;providerId:string;modelId:string;apiKey:string};
const empty=():Draft=>({name:'',providerId:'',modelId:'',apiKey:''});
export function ModelsPage(){
 const configs=useLoad('v1/api-model-configs'),catalog=useLoad('v1/providers/models'),defaults=useLoad('v1/app-settings');
 const [draft,setDraft]=useState<Draft|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[feedback,setFeedback]=useState('');
 const [checking,setChecking]=useState<string|null>(null);
 /** Ephemeral UI feedback only: cleared when leaving this page. */
 const [testResults,setTestResults]=useState<Record<string,'success'|'failed'>>({});
 const providers:Array<{providerId:string;models:Array<{id:string;name:string}>}>=catalog.value?.providers??[];
 const available=providers.find(p=>p.providerId===draft?.providerId)?.models??[];
 const items:ModelConfig[]=configs.value?.items??[];
 useEffect(()=>{if(!draft)return;const close=(e:KeyboardEvent)=>{if(e.key==='Escape')setDraft(null);};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close);},[draft]);
 const reload=async()=>{await Promise.all([configs.reload(),defaults.reload()]);};
 const persist=async()=>{
   if(!draft||busy)return;setError('');
   if(!draft.name.trim()||!draft.providerId||!draft.modelId||(!draft.id&&!draft.apiKey.trim())){setError('请补齐名称、服务商、模型与 API Key。');return;}
   setBusy(true);
   try{
     const body:any={name:draft.name.trim(),providerId:draft.providerId,modelId:draft.modelId};
     if(draft.apiKey.trim())body.apiKey=draft.apiKey.trim();
     await api('v1/api-model-configs'+(draft.id?'/'+draft.id:''),{method:draft.id?'PATCH':'POST',body:json(body)});
     if(draft.id)setTestResults(previous=>{const next={...previous};delete next[draft.id!];return next;});
     setDraft(null);setFeedback('模型配置已保存。');await reload();
   }catch(e){setError(e instanceof Error?e.message:String(e));}
   finally{setBusy(false);}
 };
 const selectDefault=async(id:string)=>{
   setFeedback('');setError('');
   try{await api('v1/app-settings',{method:'PATCH',body:json({defaultApiModelConfigId:id})});await defaults.reload();setFeedback('已设为应用默认模型。只影响之后导入的世界卡。');}
   catch(e){setError(e instanceof Error?e.message:String(e));}
 };
 const remove=async(item:ModelConfig)=>{
   if(!confirm('确定删除此模型配置？被世界卡、会话或应用默认引用的配置不能删除。'))return;
   setError('');
   try{await api('v1/api-model-configs/'+item.id,{method:'DELETE'});setTestResults(previous=>{const next={...previous};delete next[item.id];return next;});await reload();setFeedback('模型配置已删除。');}
   catch(e){setError(e instanceof Error?e.message:String(e));}
 };
 const test=async(item:ModelConfig)=>{
   if(checking)return;
   setChecking(item.id);
   setTestResults(previous=>{const next={...previous};delete next[item.id];return next;});
   try{
     await api('v1/api-model-configs/'+item.id+'/test',{method:'POST'});
     setTestResults(previous=>({...previous,[item.id]:'success'}));
   }catch{
     setTestResults(previous=>({...previous,[item.id]:'failed'}));
   }finally{setChecking(null);}
 };
 return <main className="page models-page">
  <Header eyebrow="MODEL CONNECTIONS" title="模型连接" description="为故事连接 AI 模型。每个世界和会话都可独立选择模型。"><button className="button primary" onClick={()=>{setError('');setDraft(empty());}}><Plus size={16}/> 添加模型</button></Header>
  {error&&!draft&&<ErrorNotice message={error}/>}
  {feedback&&<div className="preset-save-ok" role="status"><Check size={16}/>{feedback}</div>}
  {configs.error&&<ErrorNotice message={configs.error} onRetry={configs.reload}/>}
  {!configs.value&&configs.loading?<Loading text="正在读取模型连接…"/>:!items.length?<div className="session-empty"><KeyRound size={29}/><h2>还没有模型连接</h2><p>配置一次 API Key，导入世界卡后即可开始对话。</p><button className="button primary" onClick={()=>setDraft(empty())}><Plus size={16}/> 添加第一个模型</button></div>:
   <><div className="library-controls"><div><h2>已连接的模型 <span>{items.length}</span></h2><p>默认模型用于之后导入的世界卡。</p></div></div>
   <div className="model-collection">{items.map(item=><article className="model-item" key={item.id}>
     <div className="model-glyph"><KeyRound size={20}/></div>
     <div className="model-info"><h3>{item.name}</h3><p>{item.providerId} / {item.modelId}</p></div>
     <div className="model-flags">{defaults.value?.item?.defaultApiModelConfigId===item.id?<span className="state-chip default-model"><Check size={13}/> 应用默认</span>:<button className="button tertiary" onClick={()=>void selectDefault(item.id)}>设为默认</button>}
       <span className={'state-chip '+(item.credentialConfigured?'credential-saved':'caution')}>{item.credentialConfigured?<><ShieldCheck size={13}/> 凭据已保存</>:<><KeyRound size={13}/> 缺少凭据</>}</span>
     </div>
     <div className="model-actions"><button type="button" className={'button secondary model-test-button'+(testResults[item.id]==='success'?' is-success':testResults[item.id]==='failed'?' is-failed':'')} disabled={!item.credentialConfigured||checking!==null} title={testResults[item.id]==='failed'?'测试失败，点击重试':'实际调用模型服务商测试连接'} aria-live="polite" onClick={()=>void test(item)}>{testResults[item.id]==='success'?<Check size={15}/>:<Wifi size={15}/>} {checking===item.id?'测试中…':testResults[item.id]==='success'?'测试成功':testResults[item.id]==='failed'?'测试失败':'测试'}</button><button className="icon-button" title="编辑连接" aria-label="编辑连接" onClick={()=>{setError('');setDraft({...item,apiKey:''});}}><Settings2 size={17}/></button><button className="icon-button" title="删除连接" aria-label="删除连接" onClick={()=>void remove(item)}><Trash2 size={16}/></button></div>
   </article>)}</div></>}
  {draft&&<div className="overlay" onClick={()=>setDraft(null)}><div className="modal model-dialog" role="dialog" aria-modal="true" aria-label={draft.id?'编辑模型连接':'添加模型'} onClick={e=>e.stopPropagation()}>
    <button className="close" onClick={()=>setDraft(null)} aria-label="关闭">×</button>
    <div className="eyebrow">MODEL CONNECTION</div><h2>{draft.id?'编辑模型连接':'添加模型连接'}</h2><p className="modal-description">使用真实服务商凭据。模型连接不会自动修改已存在的世界和会话。</p>
    {error&&<ErrorNotice message={error}/>}
    <div className="editor-form">
      <label>连接名称<input value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})} placeholder="例如：我的 DeepSeek"/></label>
      <label>服务商<select value={draft.providerId} onChange={e=>{const provider=providers.find(p=>p.providerId===e.target.value);setDraft({...draft,providerId:e.target.value,modelId:provider?.models[0]?.id??''});}}><option value="">选择服务商</option>{providers.map(p=><option key={p.providerId} value={p.providerId}>{p.providerId}</option>)}</select></label>
      <label>模型<select value={draft.modelId} onChange={e=>setDraft({...draft,modelId:e.target.value})}><option value="">选择模型</option>{available.map(m=><option value={m.id} key={m.id}>{m.name}</option>)}</select></label>
      <label>API Key<input type="password" autoComplete="off" value={draft.apiKey} onChange={e=>setDraft({...draft,apiKey:e.target.value})} placeholder={draft.id?'留空则保留原有密钥':'输入 API Key'}/></label>
    </div>
    <div className="modal-actions"><button className="button secondary" onClick={()=>setDraft(null)}>取消</button><button className="button primary" disabled={busy} onClick={()=>void persist()}>{busy?'保存中…':'保存模型'}</button></div>
  </div></div>}
 </main>;
}
