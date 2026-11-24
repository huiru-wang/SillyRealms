import {useTranslation} from 'react-i18next';
import {useRef,useState} from 'react';
import {Link,useNavigate,useParams} from 'react-router-dom';
import {ArrowLeft,Check,KeyRound,LoaderCircle,Plus,Settings2,ShieldCheck,Star,Trash2} from 'lucide-react';
import {PageHeader} from '../../components/ui/PageHeader';
import {Input,Field} from '../../components/ui/Field';
import {Select} from '../../components/ui/Select';
import {Modal} from '../../components/ui/Modal';
import {Button,IconButton} from '../../components/ui/Button';
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
  const {t} = useTranslation('models');
 const {modelId}=useParams(),navigate=useNavigate();
 const {settings,saveSettings,modelsRevision,refreshModels}=useManagement();
 const configs=usePagedResource<ModelConfig>('v1/api-model-configs?limit=50',modelsRevision);
 const catalog=useResource<ModelCatalog>('v1/providers/models');
 const providers=catalog.value?.items??[];
 const selectedId=modelId??configs.page?.items[0]?.id;
 const detail=useResource<{item:ModelConfig}>(selectedId?'v1/api-model-configs/'+encodeURIComponent(selectedId):null,modelsRevision);
 const selected=detail.value?.item;
 const [draft,setDraft]=useState<ModelDraft|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<Error|string>(''),[feedback,setFeedback]=useState('');
 const [deleting,setDeleting]=useState<ModelConfig|null>(null);
 const pending=useRef(false);
 const items=configs.page?.items??[],defaultId=settings.value?.item.defaultApiModelConfigId;
 const selectedModel=selected?findCatalogModel(providers,selected.providerId,selected.modelId):undefined;
 const draftProvider=providers.find(provider=>provider.providerId===draft?.providerId);
 const draftModel=draft?findCatalogModel(providers,draft.providerId,draft.modelId):undefined;
 const catalogStatus=catalog.loading
  ?<p className={styles.catalogStatus} role="status"><LoaderCircle size={15} className="spinner-icon"/>{t('loadingModelCatalog')}</p>
  :catalog.error?<ErrorNotice message={catalog.error} onRetry={catalog.reload}/>
  :catalog.value&&!providers.length?<div className={styles.catalogStatus} role="status"><span>{t('noModelsAreAvailableInTheCatalog')}</span><Button size="compact" variant="ghost" onClick={catalog.reload}>{t('reload')}</Button></div>
  :null;

 const persist=async()=>{
  if(!draft||pending.current)return;setError('');
  const validation=modelDraftError(draft,catalog.value?.items??null);
  if(validation){setError(validation);return;}
  pending.current=true;setBusy(true);
  try{
   const body={name:draft.name.trim(),providerId:draft.providerId,modelId:draft.modelId,...(draft.apiKey.trim()?{apiKey:draft.apiKey.trim()}:{})};
   const result=await api<{item:ModelConfig}>('v1/api-model-configs'+(draft.id?'/'+encodeURIComponent(draft.id):''),{method:draft.id?'PATCH':'POST',body:json(body)});
   setDraft(null);refreshModels();navigate('/models/'+encodeURIComponent(result.item.id));setFeedback('modelConfigurationSaved');
  }catch(reason){setError(reason instanceof Error?reason:t('couldNotSave'));}
  finally{pending.current=false;setBusy(false);}
 };
 const selectDefault=async(id:string)=>{
  if(pending.current)return;pending.current=true;setBusy(true);setError('');
  try{await saveSettings({defaultApiModelConfigId:id});setFeedback('setAsTheApplicationDefaultModel');}
  catch(reason){setError(reason instanceof Error?reason:t('couldNotSave'));}
  finally{pending.current=false;setBusy(false);}
 };
 const remove=async()=>{
  if(!deleting||pending.current)return;pending.current=true;setBusy(true);setError('');
  try{await api('v1/api-model-configs/'+encodeURIComponent(deleting.id),{method:'DELETE'});setDeleting(null);refreshModels();navigate('/models');setFeedback('modelConfigurationAndCredentialsDeleted');}
  catch(reason){setError(reason instanceof Error?reason:t('couldNotDelete'));if(reason instanceof ApiError&&reason.errorCode==='CREDENTIAL_DELETE_FAILED')refreshModels();}
  finally{pending.current=false;setBusy(false);}
 };
 const openCreate=()=>{setError('');setFeedback('');setDraft(modelDraft());};
 return <section className={styles.page} data-model-workspace data-detail={!!modelId}>
  <PageHeader title={t('models:pageTitle')} actions={<Button variant="primary" icon={<Plus size={17}/>} disabled={busy} onClick={openCreate}>{t('addModel')}</Button>}/>
  {error&&!draft&&!deleting&&<ErrorNotice message={error}/>}
  {feedback&&<p className={styles.feedback} role="status"><Check size={15}/>{t(feedback)}</p>}
  <div className={styles.workspace}>
   <section className={styles.library} aria-label={t('modelConfigurationList')}>
    <div className={styles.listHeading}><span>{t('modelConfigurations')}</span><span>{items.length}</span></div>
    {configs.error&&<ErrorNotice message={configs.error} onRetry={()=>configs.page?void configs.more():configs.reload()}/>}
    {!configs.page&&configs.loading?<Loading text={t('loadingModelConfigurations')}/>:<div className={styles.list} data-model-list>
     {items.map(item=><Link key={item.id} to={'/models/'+encodeURIComponent(item.id)} className={styles.item} data-model-item={item.id} aria-current={selectedId===item.id?'page':undefined} onClick={()=>{setError('');setFeedback('');}}>
      <span className={styles.itemHeading}><strong title={item.name}>{item.name}</strong>{defaultId===item.id&&<span className={styles.defaultLabel}>{t('default')}</span>}</span>
      <span className={styles.itemMeta}>{item.providerId} / {item.modelId}</span>
     </Link>)}
     {configs.page&&!items.length&&<div className={styles.empty}><KeyRound size={25}/><strong>{t('noModelConfigurationsYet')}</strong><Button onClick={openCreate}>{t('addYourFirstModel')}</Button></div>}
     {configs.page?.hasMore&&<Button disabled={configs.loading} onClick={()=>void configs.more()}>{t('loadMore')}</Button>}
    </div>}
   </section>
   <section className={styles.detail} aria-label={t('modelConfigurationDetails')}>
    <Link className={styles.back} to="/models"><ArrowLeft size={16}/>{t('backToModels')}</Link>
    {detail.loading&&<Loading text={t('loadingConnection')}/>}
    {detail.error&&<ErrorNotice message={detail.error} onRetry={detail.reload}/>}
    {selected?<>
     <header className={styles.detailHeader}>
      <div><h2>{selected.name}</h2><p>{selected.providerId}</p></div>
      <div className={styles.detailActions} role="group" aria-label={t('modelConfigurationActions')}>
       <ModelConnectionTest key={selected.id+":"+selected.updatedAt+":"+selected.credentialStatus} model={selected} disabled={busy||!!draft}/>
       <Button size="compact" icon={defaultId===selected.id?<Check size={16}/>:<Star size={16}/>} disabled={busy||!settings.value||defaultId===selected.id} aria-label={defaultId===selected.id?t('currentDefaultModel'):t('setAsDefaultModel')} title={defaultId===selected.id?t('currentApplicationDefaultModel'):t('useAsTheApplicationDefaultForWorlds')} onClick={()=>void selectDefault(selected.id)}>{defaultId===selected.id?t('currentDefault'):t('default')}</Button>
       <IconButton size="compact" icon={<Settings2 size={16}/>} aria-label={t('editModelConfiguration')} title={t('editModelConfiguration')} disabled={busy} onClick={()=>{setError('');setDraft(modelDraft(selected));}}/>
       <IconButton size="compact" intent="danger" icon={<Trash2 size={16}/>} aria-label={t('deleteModelConfiguration')} title={t('deleteModelConfiguration')} disabled={busy} onClick={()=>{setError('');setDeleting(selected);}}/>
      </div>
     </header>
     <div className={styles.detailBody}>
      <dl className={styles.facts}>
       <div><dt>{t('connectionName')}</dt><dd>{selected.name}</dd></div>
       <div><dt>{t('provider')}</dt><dd>{providers.find(provider=>provider.providerId===selected.providerId)?.name??selected.providerId}</dd></div>
       <div><dt>{t('model')}</dt><dd>{selectedModel?.name??selected.modelId}</dd></div>
       <div><dt>API Key</dt><dd className={styles.credential}>{selected.credentialStatus==='configured'?<><ShieldCheck size={16}/>{t('credentialsSaved')}</>:selected.credentialStatus==='unavailable'?t('credentialStorageIsUnavailable'):t('noSavedCredentials')}</dd></div>
      </dl>
      <div className={styles.metadataSection}>
       {!draft&&catalogStatus}
       {selectedModel?<ModelMetadata model={selectedModel}/>:catalog.value&&providers.length>0&&<p className={styles.catalogStatus} role="status">{t('thisModelIsNotInTheCatalog')}</p>}
      </div>
      {settings.error&&<ErrorNotice message={settings.error} onRetry={settings.reload}/>}
     </div>
    </>:!detail.loading&&!detail.error&&<div className={styles.empty}><KeyRound size={26}/><h2>{t('selectAModelConfiguration')}</h2></div>}
   </section>
  </div>
  {draft&&<Modal title={draft.id?t('editModelConnection'):t('addModelConnection')} onBeforeClose={()=>!pending.current} onClose={()=>setDraft(null)} footer={<><Button disabled={busy} onClick={()=>setDraft(null)}>{t('cancel')}</Button><Button variant="primary" loading={busy} disabled={!keepsSavedSelection(draft)&&!draftModel} onClick={()=>void persist()}>{t('saveModel')}</Button></>}>
   {error&&<ErrorNotice message={error}/>}
   <div className="editor-form">
    <div className={styles.catalogFields}>
     {catalogStatus}
     <Field label={t('provider')}><Select aria-label={t('provider')} disabled={busy||catalog.loading||!providers.length} value={draft.providerId} onChange={event=>{const providerId=event.target.value;setError('');setDraft(current=>current?changeProvider(current,providerId):null);}}>
      <option value="">{t('selectAProvider')}</option>
      {draft.providerId&&!draftProvider&&<option value={draft.providerId} disabled>{draft.providerId} ({catalog.value?t('notInCatalog'):t('saved')})</option>}
      {providers.map(provider=><option key={provider.providerId} value={provider.providerId}>{provider.name===provider.providerId?provider.name:provider.name+' · '+provider.providerId}</option>)}
     </Select></Field>
     <Field label={t('model')}><Select aria-label={t('model')} disabled={busy||catalog.loading||!draftProvider?.models.length} value={draft.modelId} onChange={event=>{const selectedModelId=event.target.value;setError('');setDraft(current=>current?{...current,modelId:selectedModelId}:null);}}>
      <option value="">{draft.providerId?t('selectAModel'):t('selectAProviderFirst')}</option>
      {draft.modelId&&!draftModel&&<option value={draft.modelId} disabled>{draft.modelId} ({catalog.value?t('notInCatalog'):t('saved')})</option>}
      {draftProvider?.models.map(model=><option key={model.modelId} value={model.modelId}>{model.name===model.modelId?model.name:model.name+' · '+model.modelId}</option>)}
     </Select></Field>
     {draftModel&&<ModelMetadata model={draftModel}/>}
     {catalog.value&&draft.modelId&&!draftModel&&<p className={styles.catalogStatus} role="status">{keepsSavedSelection(draft)?t('thisModelIsNotInTheCatalog2'):t('theSelectedModelIsNoLongerIn')}</p>}
    </div>
    <Field label={t('connectionName')}><Input disabled={busy} value={draft.name} placeholder={draftModel?.name??t('forExampleEverydayStorytelling')} onChange={event=>setDraft({...draft,name:event.target.value})}/></Field>
    <Field label="API Key"><Input disabled={busy} type="password" autoComplete="off" value={draft.apiKey} placeholder={draft.id?(draft.original?.providerId===draft.providerId?t('leaveBlankToKeepTheSavedKey'):t('enterANewApiKeyAfterChanging')):t('enterApiKey')} onChange={event=>setDraft({...draft,apiKey:event.target.value})}/></Field>
   </div>
  </Modal>}
  {deleting&&<Modal title={t('deleteModelConfiguration')} onBeforeClose={()=>!pending.current} onClose={()=>setDeleting(null)} footer={<><Button disabled={busy} onClick={()=>setDeleting(null)}>{t('cancel')}</Button><Button variant="primary" intent="danger" loading={busy} onClick={()=>void remove()}>{t('delete')}</Button></>}><p>{t('models:deleteConfirmation',{name:deleting.name})}</p>{error&&<ErrorNotice message={error}/>}</Modal>}
 </section>;
}
