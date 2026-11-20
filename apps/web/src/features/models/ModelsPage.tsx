import {useRef,useState} from 'react';
import {Link,useNavigate,useParams} from 'react-router-dom';
import {ArrowLeft,Check,KeyRound,LoaderCircle,Plus,Settings2,ShieldCheck,Trash2} from 'lucide-react';
import {PageHeader} from '../../components/ui/PageHeader';
import {Input,Field} from '../../components/ui/Field';
import {Select} from '../../components/ui/Select';
import {Modal} from '../../components/ui/Modal';
import {Button} from '../../components/ui/Button';
import {api,ApiError,json} from '../../api';
import {ErrorNotice,Loading} from '../../app/ui';
import {useManagement} from '../../app/ManagementData';
import {usePagedResource,useResource} from '../../data';
import {changeProvider,findCatalogModel,keepsSavedSelection,modelDraft,modelDraftError} from './catalog';
import {ModelMetadata} from './ModelMetadata';
import {ModelConnectionTest} from './ModelConnectionTest';
import type {ModelCatalog,ModelConfig,ModelDraft} from './types';
import styles from './ModelsPage.module.css';

export function ModelsPage(){
 const {modelId}=useParams(),navigate=useNavigate();
 const {settings,saveSettings,modelsRevision,refreshModels}=useManagement();
 const configs=usePagedResource<ModelConfig>('v1/api-model-configs?limit=50',modelsRevision);
 const catalog=useResource<ModelCatalog>('v1/providers/models');
 const providers=catalog.value?.items??[];
 const selectedId=modelId??configs.page?.items[0]?.id;
 const detail=useResource<{item:ModelConfig}>(selectedId?'v1/api-model-configs/'+encodeURIComponent(selectedId):null,modelsRevision);
 const selected=detail.value?.item;
 const [draft,setDraft]=useState<ModelDraft|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[feedback,setFeedback]=useState('');
 const [deleting,setDeleting]=useState<ModelConfig|null>(null);
 const pending=useRef(false);
 const items=configs.page?.items??[],defaultId=settings.value?.item.defaultApiModelConfigId;
 const selectedModel=selected?findCatalogModel(providers,selected.providerId,selected.modelId):undefined;
 const draftProvider=providers.find(provider=>provider.providerId===draft?.providerId);
 const draftModel=draft?findCatalogModel(providers,draft.providerId,draft.modelId):undefined;
 const catalogStatus=catalog.loading
  ?<p className={styles.catalogStatus} role="status"><LoaderCircle size={15} className="spinner-icon"/>正在读取模型目录…</p>
  :catalog.error?<ErrorNotice message={catalog.error} onRetry={catalog.reload}/>
  :catalog.value&&!providers.length?<div className={styles.catalogStatus} role="status"><span>模型目录暂无可选模型。</span><Button size="compact" variant="ghost" onClick={catalog.reload}>重新读取</Button></div>
  :null;

 const persist=async()=>{
  if(!draft||pending.current)return;setError('');
  const validation=modelDraftError(draft,catalog.value?.items??null);
  if(validation){setError(validation);return;}
  pending.current=true;setBusy(true);
  try{
   const body={name:draft.name.trim(),providerId:draft.providerId,modelId:draft.modelId,...(draft.apiKey.trim()?{apiKey:draft.apiKey.trim()}:{})};
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
 const openCreate=()=>{setError('');setFeedback('');setDraft(modelDraft());};
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
     <header className={styles.detailHeader}><div><h2>{selected.name}</h2><p>{selected.providerId}</p></div><Button icon={<Settings2 size={16}/>} aria-label="编辑连接" disabled={busy} onClick={()=>{setError('');setDraft(modelDraft(selected));}}>编辑</Button></header>
     <div className={styles.detailBody}>
      <dl className={styles.facts}>
       <div><dt>连接名称</dt><dd>{selected.name}</dd></div>
       <div><dt>服务商</dt><dd>{providers.find(provider=>provider.providerId===selected.providerId)?.name??selected.providerId}</dd></div>
       <div><dt>模型</dt><dd>{selectedModel?.name??selected.modelId}</dd></div>
       <div><dt>API Key</dt><dd className={styles.credential}>{selected.credentialStatus==='configured'?<><ShieldCheck size={16}/>凭据已保存</>:selected.credentialStatus==='unavailable'?'无法读取本机凭据存储':'尚未保存凭据'}</dd></div>
      </dl>
      <div className={styles.metadataSection}>
       {!draft&&catalogStatus}
       {selectedModel?<ModelMetadata model={selectedModel}/>:catalog.value&&providers.length>0&&<p className={styles.catalogStatus} role="status">当前配置的模型未在目录中，已保存的连接保持不变。</p>}
      </div>
      <ModelConnectionTest key={selected.id+":"+selected.updatedAt+":"+selected.credentialStatus} model={selected} disabled={busy||!!draft} editing={!!draft}/>
      <section className={styles.preference}><div><h3>应用默认模型</h3><p>用于之后导入的世界卡。</p></div>{defaultId===selected.id?<span className={styles.defaultState}><Check size={15}/>当前默认</span>:<Button disabled={busy||!settings.value} onClick={()=>void selectDefault(selected.id)}>设为默认</Button>}</section>
      {settings.error&&<ErrorNotice message={settings.error} onRetry={settings.reload}/>}
      <div className={styles.connectionActions}><Button variant="ghost" intent="danger" icon={<Trash2 size={16}/>} disabled={busy} onClick={()=>{setError('');setDeleting(selected);}}>删除配置</Button></div>
     </div>
    </>:!detail.loading&&!detail.error&&<div className={styles.empty}><KeyRound size={26}/><h2>选择一个模型配置</h2></div>}
   </section>
  </div>
  {draft&&<Modal title={draft.id?'编辑模型连接':'添加模型连接'} onBeforeClose={()=>!pending.current} onClose={()=>setDraft(null)} footer={<><Button disabled={busy} onClick={()=>setDraft(null)}>取消</Button><Button variant="primary" loading={busy} disabled={!keepsSavedSelection(draft)&&!draftModel} onClick={()=>void persist()}>保存模型</Button></>}>
   {error&&<ErrorNotice message={error}/>}
   <div className="editor-form">
    <div className={styles.catalogFields}>
     {catalogStatus}
     <Field label="服务商"><Select aria-label="服务商" disabled={busy||catalog.loading||!providers.length} value={draft.providerId} onChange={event=>{const providerId=event.target.value;setError('');setDraft(current=>current?changeProvider(current,providerId):null);}}>
      <option value="">选择服务商</option>
      {draft.providerId&&!draftProvider&&<option value={draft.providerId} disabled>{draft.providerId}（{catalog.value?'目录未提供':'已保存'}）</option>}
      {providers.map(provider=><option key={provider.providerId} value={provider.providerId}>{provider.name===provider.providerId?provider.name:provider.name+' · '+provider.providerId}</option>)}
     </Select></Field>
     <Field label="模型"><Select aria-label="模型" disabled={busy||catalog.loading||!draftProvider?.models.length} value={draft.modelId} onChange={event=>{const selectedModelId=event.target.value;setError('');setDraft(current=>current?{...current,modelId:selectedModelId}:null);}}>
      <option value="">{draft.providerId?'选择模型':'先选择服务商'}</option>
      {draft.modelId&&!draftModel&&<option value={draft.modelId} disabled>{draft.modelId}（{catalog.value?'目录未提供':'已保存'}）</option>}
      {draftProvider?.models.map(model=><option key={model.modelId} value={model.modelId}>{model.name===model.modelId?model.name:model.name+' · '+model.modelId}</option>)}
     </Select></Field>
     {draftModel&&<ModelMetadata model={draftModel}/>}
     {catalog.value&&draft.modelId&&!draftModel&&<p className={styles.catalogStatus} role="status">{keepsSavedSelection(draft)?'当前模型未在目录中，可保留原选择并更新名称或密钥。':'所选模型已不在目录中，请重新选择。'}</p>}
    </div>
    <Field label="连接名称"><Input disabled={busy} value={draft.name} placeholder={draftModel?.name??'例如：日常叙事模型'} onChange={event=>setDraft({...draft,name:event.target.value})}/></Field>
    <Field label="API Key"><Input disabled={busy} type="password" autoComplete="off" value={draft.apiKey} placeholder={draft.id?(draft.original?.providerId===draft.providerId?'留空保留原有密钥':'更换服务商后填写新的 API Key'):'输入 API Key'} onChange={event=>setDraft({...draft,apiKey:event.target.value})}/></Field>
   </div>
  </Modal>}
  {deleting&&<Modal title="删除模型配置" onBeforeClose={()=>!pending.current} onClose={()=>setDeleting(null)} footer={<><Button disabled={busy} onClick={()=>setDeleting(null)}>取消</Button><Button variant="primary" intent="danger" loading={busy} onClick={()=>void remove()}>确认删除</Button></>}><p>删除“{deleting.name}”及其凭据？被世界、会话或应用默认引用的配置不能删除。</p>{error&&<ErrorNotice message={error}/>}</Modal>}
 </section>;
}
