import {useRef,useState} from 'react';
import {Link,useNavigate,useParams} from 'react-router-dom';
import {ArrowLeft,Check,KeyRound,Plus,Settings2,ShieldCheck,Trash2} from 'lucide-react';
import {PageHeader} from '../../components/ui/PageHeader';
import {Input,Field} from '../../components/ui/Field';
import {Modal} from '../../components/ui/Modal';
import {Button} from '../../components/ui/Button';
import {api,ApiError,json} from '../../api';
import {ErrorNotice,Loading} from '../../app/ui';
import {useManagement} from '../../app/ManagementData';
import {usePagedResource,useResource} from '../../data';
import type {ModelConfig} from './types';
import styles from './ModelsPage.module.css';

type Draft={id?:string;name:string;providerId:string;modelId:string;apiKey:string};
const empty=():Draft=>({name:'',providerId:'',modelId:'',apiKey:''});
export function ModelsPage(){
 const {modelId}=useParams(),navigate=useNavigate();
 const {settings,saveSettings,modelsRevision,refreshModels}=useManagement();
 const configs=usePagedResource<ModelConfig>('v1/api-model-configs?limit=50',modelsRevision);
 const selectedId=modelId??configs.page?.items[0]?.id;
 const detail=useResource<{item:ModelConfig}>(selectedId?'v1/api-model-configs/'+encodeURIComponent(selectedId):null,modelsRevision);
 const selected=detail.value?.item;
 const [draft,setDraft]=useState<Draft|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[feedback,setFeedback]=useState('');
 const [deleting,setDeleting]=useState<ModelConfig|null>(null);
 const pending=useRef(false);
 const items=configs.page?.items??[],defaultId=settings.value?.item.defaultApiModelConfigId;
 const persist=async()=>{
  if(!draft||pending.current)return;setError('');
  if(!draft.name.trim()||!draft.providerId.trim()||!draft.modelId.trim()||(!draft.id&&!draft.apiKey.trim())){setError('请填写名称、服务商标识、模型标识和 API Key。');return;}
  pending.current=true;setBusy(true);
  try{
   const body={name:draft.name.trim(),providerId:draft.providerId.trim(),modelId:draft.modelId.trim(),...(draft.apiKey.trim()?{apiKey:draft.apiKey.trim()}:{})};
   const result=await api<{item:ModelConfig}>('v1/api-model-configs'+(draft.id?'/'+encodeURIComponent(draft.id):''),{method:draft.id?'PATCH':'POST',body:json(body)});
   setDraft(null);refreshModels();navigate('/models/'+encodeURIComponent(result.item.id));setFeedback('模型配置已保存。');
  }catch(reason){setError(reason instanceof Error?reason.message:'保存失败');}
  finally{pending.current=false;setBusy(false);}
 };
 const selectDefault=async(id:string)=>{
  if(pending.current)return;pending.current=true;setBusy(true);setError('');
  try{await saveSettings({defaultApiModelConfigId:id});setFeedback('已设为应用默认模型。');}
  catch(reason){setError(reason instanceof Error?reason.message:'保存失败');}
  finally{pending.current=false;setBusy(false);}
 };
 const remove=async()=>{
  if(!deleting||pending.current)return;pending.current=true;setBusy(true);setError('');
  try{await api('v1/api-model-configs/'+encodeURIComponent(deleting.id),{method:'DELETE'});setDeleting(null);refreshModels();navigate('/models');setFeedback('模型配置和凭据已删除。');}
  catch(reason){setError(reason instanceof Error?reason.message:'删除失败');if(reason instanceof ApiError&&reason.errorCode==='CREDENTIAL_DELETE_FAILED')refreshModels();}
  finally{pending.current=false;setBusy(false);}
 };
 const openCreate=()=>{setError('');setFeedback('');setDraft(empty());};
 return <section className={styles.page} data-model-workspace data-detail={!!modelId}>
  <PageHeader title="模型" actions={<Button variant="primary" icon={<Plus size={17}/>} disabled={busy} onClick={openCreate}>添加模型</Button>}/>
  {error&&!draft&&!deleting&&<ErrorNotice message={error}/>}
  {feedback&&<p className={styles.feedback} role="status"><Check size={15}/>{feedback}</p>}
  <div className={styles.workspace}>
   <section className={styles.library} aria-label="模型配置列表">
    <div className={styles.listHeading}><span>模型配置</span><span>{items.length}</span></div>
    {configs.error&&<ErrorNotice message={configs.error} onRetry={()=>configs.page?void configs.more():configs.reload()}/>}
    {!configs.page&&configs.loading?<Loading text="正在读取模型配置…"/>:<div className={styles.list} data-model-list>
     {items.map(item=><Link key={item.id} to={'/models/'+encodeURIComponent(item.id)} className={styles.item} data-model-item={item.id} aria-current={selectedId===item.id?'page':undefined} onClick={()=>{setError('');setFeedback('');}}>
      <span className={styles.itemHeading}><strong title={item.name}>{item.name}</strong>{defaultId===item.id&&<span className={styles.defaultLabel}>默认</span>}</span>
      <span className={styles.itemMeta}>{item.providerId} / {item.modelId}</span>
     </Link>)}
     {configs.page&&!items.length&&<div className={styles.empty}><KeyRound size={25}/><strong>还没有模型配置</strong><Button onClick={openCreate}>添加第一个模型</Button></div>}
     {configs.page?.hasMore&&<Button disabled={configs.loading} onClick={()=>void configs.more()}>加载更多</Button>}
    </div>}
   </section>
   <section className={styles.detail} aria-label="模型配置详情">
    <Link className={styles.back} to="/models"><ArrowLeft size={16}/>返回模型列表</Link>
    {detail.loading&&<Loading text="正在读取连接…"/>}
    {detail.error&&<ErrorNotice message={detail.error} onRetry={detail.reload}/>}
    {selected?<>
     <header className={styles.detailHeader}><div><h2>{selected.name}</h2><p>{selected.providerId}</p></div><Button icon={<Settings2 size={16}/>} aria-label="编辑连接" disabled={busy} onClick={()=>{setError('');setDraft({id:selected.id,name:selected.name,providerId:selected.providerId,modelId:selected.modelId,apiKey:''});}}>编辑</Button></header>
     <div className={styles.detailBody}>
      <dl className={styles.facts}>
       <div><dt>连接名称</dt><dd>{selected.name}</dd></div>
       <div><dt>服务商标识</dt><dd>{selected.providerId}</dd></div>
       <div><dt>模型标识</dt><dd>{selected.modelId}</dd></div>
       <div><dt>API Key</dt><dd className={styles.credential}>{selected.credentialStatus==='configured'?<><ShieldCheck size={16}/>凭据已保存</>:selected.credentialStatus==='unavailable'?'无法读取本机凭据存储':'尚未保存凭据'}</dd></div>
      </dl>
      <p>连接信息已保存后，可用于绑定配置。尚未验证模型调用。</p>
      <section className={styles.preference}><div><h3>应用默认模型</h3><p>用于之后导入的世界卡。</p></div>{defaultId===selected.id?<span className={styles.defaultState}><Check size={15}/>当前默认</span>:<Button disabled={busy||!settings.value} onClick={()=>void selectDefault(selected.id)}>设为默认</Button>}</section>
      {settings.error&&<ErrorNotice message={settings.error} onRetry={settings.reload}/>}
      <div className={styles.connectionActions}><Button variant="ghost" intent="danger" icon={<Trash2 size={16}/>} disabled={busy} onClick={()=>{setError('');setDeleting(selected);}}>删除配置</Button></div>
     </div>
    </>:!detail.loading&&!detail.error&&<div className={styles.empty}><KeyRound size={26}/><h2>选择一个模型配置</h2></div>}
   </section>
  </div>
  {draft&&<Modal title={draft.id?'编辑模型连接':'添加模型连接'} onBeforeClose={()=>!pending.current} onClose={()=>setDraft(null)} footer={<><Button disabled={busy} onClick={()=>setDraft(null)}>取消</Button><Button variant="primary" loading={busy} onClick={()=>void persist()}>保存模型</Button></>}>
   {error&&<ErrorNotice message={error}/>}
   <div className="editor-form">
    <Field label="连接名称"><Input disabled={busy} value={draft.name} onChange={event=>setDraft({...draft,name:event.target.value})}/></Field>
    <Field label="服务商标识"><Input disabled={busy} value={draft.providerId} placeholder="例如 openai" onChange={event=>setDraft({...draft,providerId:event.target.value})}/></Field>
    <Field label="模型标识"><Input disabled={busy} value={draft.modelId} onChange={event=>setDraft({...draft,modelId:event.target.value})}/></Field>
    <Field label="API Key"><Input disabled={busy} type="password" autoComplete="off" value={draft.apiKey} placeholder={draft.id?'留空保留原有密钥；更换服务商需填写':'输入 API Key'} onChange={event=>setDraft({...draft,apiKey:event.target.value})}/></Field>
   </div>
  </Modal>}
  {deleting&&<Modal title="删除模型配置" onBeforeClose={()=>!pending.current} onClose={()=>setDeleting(null)} footer={<><Button disabled={busy} onClick={()=>setDeleting(null)}>取消</Button><Button variant="primary" intent="danger" loading={busy} onClick={()=>void remove()}>确认删除</Button></>}><p>删除“{deleting.name}”及其凭据？被世界、会话或应用默认引用的配置不能删除。</p>{error&&<ErrorNotice message={error}/>}</Modal>}
 </section>;
}
