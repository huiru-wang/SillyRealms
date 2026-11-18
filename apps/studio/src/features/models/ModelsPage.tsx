import {PageHeader} from '../../components/ui/PageHeader';
import {Input,Field} from '../../components/ui/Field';
import {Select} from '../../components/ui/Select';
import {Modal} from '../../components/ui/Modal';
import {Button} from '../../components/ui/Button';
import {useRef,useState} from 'react';
import {Link,useNavigate,useParams} from 'react-router-dom';
import {ArrowLeft,Check,KeyRound,Plus,Settings2,ShieldCheck,Trash2,Wifi} from 'lucide-react';
import {api,json} from '../../api';
import {ErrorNotice,Loading,useLoad} from '../../app/ui';
import styles from './ModelsPage.module.css';

type ModelConfig={id:string;name:string;providerId:string;modelId:string;credentialConfigured:boolean};
type Draft={id?:string;name:string;providerId:string;modelId:string;apiKey:string};
const empty=():Draft=>({name:'',providerId:'',modelId:'',apiKey:''});
// Match the preset workspace: list -> selected connection -> secondary metadata.
// Reuse semantic colors and shared controls; adding a connection is the primary page action.
export function ModelsPage(){
 const {modelId}=useParams(),navigate=useNavigate();
 const configs=useLoad('v1/api-model-configs'),catalog=useLoad('v1/providers/models'),defaults=useLoad('v1/app-settings');
 const [draft,setDraft]=useState<Draft|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[feedback,setFeedback]=useState('');
 const [deleting,setDeleting]=useState<ModelConfig|null>(null),[checking,setChecking]=useState<string|null>(null);
 const pending=useRef(false);
 /** Ephemeral UI feedback only: cleared when leaving this page. */
 const [testResults,setTestResults]=useState<Record<string,'success'|'failed'>>({});
 const providers:Array<{providerId:string;models:Array<{id:string;name:string}>}>=catalog.value?.providers??[];
 const available=providers.find(p=>p.providerId===draft?.providerId)?.models??[];
 const items:ModelConfig[]=configs.value?.items??[];
 const selected=modelId?items.find(item=>item.id===modelId):items[0];
 const defaultId=defaults.value?.item?.defaultApiModelConfigId;
 const reload=async()=>{await Promise.all([configs.reload(),defaults.reload()]);};
 const changed=()=>window.dispatchEvent(new Event('sr:models-changed'));
 const persist=async()=>{
   if(!draft||pending.current)return;setError('');
   if(!draft.name.trim()||!draft.providerId||!draft.modelId||(!draft.id&&!draft.apiKey.trim())){setError('请补齐名称、服务商、模型与 API Key。');return;}
   pending.current=true;setBusy(true);
   try{
     const body:{name:string;providerId:string;modelId:string;apiKey?:string}={name:draft.name.trim(),providerId:draft.providerId,modelId:draft.modelId};
     if(draft.apiKey.trim())body.apiKey=draft.apiKey.trim();
     const result=await api('v1/api-model-configs'+(draft.id?'/'+encodeURIComponent(draft.id):''),{method:draft.id?'PATCH':'POST',body:json(body)});
     if(draft.id)setTestResults(previous=>{const next={...previous};delete next[draft.id!];return next;});
     setDraft(null);await reload();changed();navigate('/models/'+encodeURIComponent(result.item.id));setFeedback('模型配置已保存。');
   }catch(e){setError(e instanceof Error?e.message:String(e));}
   finally{pending.current=false;setBusy(false);}
 };
 const selectDefault=async(id:string)=>{
   if(pending.current)return;pending.current=true;setBusy(true);setFeedback('');setError('');
   try{await api('v1/app-settings',{method:'PATCH',body:json({defaultApiModelConfigId:id})});await defaults.reload();window.dispatchEvent(new Event('sr:settings-changed'));setFeedback('已设为应用默认模型。只影响之后导入的世界卡。');}
   catch(e){setError(e instanceof Error?e.message:String(e));}
   finally{pending.current=false;setBusy(false);}
 };
 const remove=async()=>{
   if(!deleting||pending.current)return;pending.current=true;setBusy(true);setError('');
   try{await api('v1/api-model-configs/'+encodeURIComponent(deleting.id),{method:'DELETE'});setTestResults(previous=>{const next={...previous};delete next[deleting.id];return next;});setDeleting(null);await reload();changed();navigate('/models');setFeedback('模型配置已删除。');}
   catch(e){setError(e instanceof Error?e.message:String(e));}
   finally{pending.current=false;setBusy(false);}
 };
 const test=async(item:ModelConfig)=>{
   if(checking)return;setChecking(item.id);
   setTestResults(previous=>{const next={...previous};delete next[item.id];return next;});
   try{await api('v1/api-model-configs/'+encodeURIComponent(item.id)+'/test',{method:'POST'});setTestResults(previous=>({...previous,[item.id]:'success'}));}
   catch{setTestResults(previous=>({...previous,[item.id]:'failed'}));}
   finally{setChecking(null);}
 };
 const openCreate=()=>{setError('');setFeedback('');setDraft(empty());};
 return <section className={styles.page} data-model-workspace data-detail={!!modelId}>
  <PageHeader title="模型" actions={<Button variant="primary" icon={<Plus size={17}/>} disabled={busy} onClick={openCreate}>添加模型</Button>}/>
  {error&&!draft&&!deleting&&<ErrorNotice message={error}/>}
  {feedback&&<p className={styles.feedback} role="status"><Check size={15}/>{feedback}</p>}
  <div className={styles.workspace}>
   <section className={styles.library} aria-label="模型配置列表">
    <div className={styles.listHeading}><span>模型配置</span><span>{items.length}</span></div>
    {configs.error&&<ErrorNotice message={configs.error} onRetry={configs.reload}/>}
    {!configs.value&&configs.loading?<Loading text="正在读取模型配置…"/>:<div className={styles.list} data-model-list>
     {items.map(item=><Link key={item.id} to={'/models/'+encodeURIComponent(item.id)} className={styles.item} data-model-item={item.id} aria-current={selected?.id===item.id?'page':undefined} onClick={()=>{setError('');setFeedback('');}}>
       <span className={styles.itemHeading}><strong title={item.name}>{item.name}</strong>{defaultId===item.id&&<span className={styles.defaultLabel}>默认</span>}</span>
       <span className={styles.itemMeta} title={item.providerId+' / '+item.modelId}>{item.providerId} / {item.modelId}</span>
     </Link>)}
     {configs.value&&!items.length&&<div className={styles.empty}><KeyRound size={25}/><strong>还没有模型配置</strong><p>添加模型连接，开始你的故事。</p><Button onClick={openCreate}>添加第一个模型</Button></div>}
    </div>}
   </section>
   <section className={styles.detail} aria-label="模型配置详情">
    <Link className={styles.back} to="/models"><ArrowLeft size={16}/>返回模型列表</Link>
    {selected?<>
     <header className={styles.detailHeader}><div><h2 title={selected.name}>{selected.name}</h2><p>{selected.providerId}</p></div><Button icon={<Settings2 size={16}/>} aria-label="编辑连接" disabled={busy||checking!==null} onClick={()=>{setError('');setDraft({...selected,apiKey:''});}}>编辑</Button></header>
     <div className={styles.detailBody}>
      <dl className={styles.facts}>
       <div><dt>连接名称</dt><dd>{selected.name}</dd></div>
       <div><dt>服务商</dt><dd>{selected.providerId}</dd></div>
       <div><dt>模型</dt><dd>{selected.modelId}</dd></div>
       <div><dt>API Key</dt><dd className={styles.credential}>{selected.credentialConfigured?<><ShieldCheck size={16}/>凭据已保存</>:<><KeyRound size={16}/>缺少凭据</>}</dd></div>
      </dl>
      <section className={styles.preference}><div><h3>应用默认模型</h3><p>用于之后导入的世界卡。</p></div>{defaultId===selected.id?<span className={styles.defaultState}><Check size={15}/>当前默认</span>:<Button disabled={busy} onClick={()=>void selectDefault(selected.id)}>设为默认</Button>}</section>
      {defaults.error&&<ErrorNotice message={defaults.error} onRetry={defaults.reload}/>}
      <div className={styles.connectionActions}>
       <Button className={'model-test-button'+(testResults[selected.id]==='success'?' is-success':testResults[selected.id]==='failed'?' is-failed':'')} disabled={!selected.credentialConfigured||checking!==null||busy} title="实际调用模型服务商测试连接" aria-live="polite" icon={testResults[selected.id]==='success'?<Check size={15}/>:<Wifi size={15}/>} onClick={()=>void test(selected)}>{checking===selected.id?'测试中…':testResults[selected.id]==='success'?'测试成功':testResults[selected.id]==='failed'?'测试失败，重试':'测试连接'}</Button>
       <Button variant="ghost" intent="danger" icon={<Trash2 size={16}/>} disabled={busy||checking!==null} aria-label="删除连接" onClick={()=>{setError('');setDeleting(selected);}}>删除配置</Button>
      </div>
     </div>
    </>:configs.value&&<div className={styles.empty}><KeyRound size={26}/><h2>{modelId?'模型配置不存在':'选择一个模型配置'}</h2><p>{modelId?'该配置可能已被删除，请从列表选择其他配置。':'在左侧查看连接信息和凭据状态。'}</p>{modelId&&<Link to="/models">返回模型列表</Link>}</div>}
   </section>
  </div>
  {draft&&<Modal title={draft.id?'编辑模型连接':'添加模型连接'} onBeforeClose={()=>!pending.current} onClose={()=>setDraft(null)} footer={<><Button disabled={busy} onClick={()=>setDraft(null)}>取消</Button><Button variant="primary" loading={busy} onClick={()=>void persist()}>{busy?'保存中…':'保存模型'}</Button></>}>
    {error&&<ErrorNotice message={error}/>}
    {catalog.error&&<ErrorNotice message={catalog.error} onRetry={catalog.reload}/>}
    <div className="editor-form">
      <Field label="连接名称"><Input value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})} placeholder="例如：我的 DeepSeek"/></Field>
      <Field label="服务商"><Select aria-label="服务商" value={draft.providerId} onChange={e=>{const provider=providers.find(p=>p.providerId===e.target.value);setDraft({...draft,providerId:e.target.value,modelId:provider?.models[0]?.id??''});}}><option value="">选择服务商</option>{draft.providerId&&!providers.some(p=>p.providerId===draft.providerId)&&<option value={draft.providerId}>{draft.providerId}</option>}{providers.map(p=><option key={p.providerId} value={p.providerId}>{p.providerId}</option>)}</Select></Field>
      <Field label="模型"><Select aria-label="模型" value={draft.modelId} onChange={e=>setDraft({...draft,modelId:e.target.value})}><option value="">选择模型</option>{draft.modelId&&!available.some(m=>m.id===draft.modelId)&&<option value={draft.modelId}>{draft.modelId}</option>}{available.map(m=><option value={m.id} key={m.id}>{m.name}</option>)}</Select></Field>
      <Field label="API Key"><Input type="password" autoComplete="off" value={draft.apiKey} onChange={e=>setDraft({...draft,apiKey:e.target.value})} placeholder={draft.id?'留空则保留原有密钥':'输入 API Key'}/></Field>
    </div>
  </Modal>}
  {deleting&&<Modal title="删除模型配置" onBeforeClose={()=>!pending.current} onClose={()=>setDeleting(null)} footer={<><Button disabled={busy} onClick={()=>setDeleting(null)}>取消</Button><Button variant="primary" intent="danger" loading={busy} onClick={()=>void remove()}>{busy?'正在删除…':'确认删除'}</Button></>}><p>确定删除「{deleting.name}」？被世界卡、会话或应用默认引用的配置不能删除。</p>{error&&<ErrorNotice message={error}/>}</Modal>}
 </section>;
}
