import {useTranslation} from 'react-i18next';
import {useRef,useState} from 'react';
import {useNavigate,useSearchParams} from 'react-router-dom';
import {Info,Upload} from 'lucide-react';
import {PageHeader} from '../../components/ui/PageHeader';
import {Button,UploadButton} from '../../components/ui/Button';
import {api,ApiError} from '../../api';
import {usePagedResource,useResource} from '../../data';
import {useManagement} from '../../app/ManagementData';
import {ErrorNotice} from '../../app/ui';
import type {Tag,WorldListItem,WorldDetail} from './api/worlds';
import {WorldCard} from './WorldCard';
import {WorldCleanupNotice} from './WorldActions';
import styles from './WorldLibraryPage.module.css';
// Primary: find/read a world; one primary action: import. Existing surface/text tokens and card spacing.
export function WorldLibraryPage(){
  const {t} = useTranslation('worlds');
 const [query,setQuery]=useSearchParams(),navigate=useNavigate();
 const tag=query.get('tag')??'';
 const [importing,setImporting]=useState(false),[error,setError]=useState<Error|string>('');
 const pending=useRef(false);const {worldsRevision,sessionsRevision,refreshWorlds}=useManagement();
 const params=new URLSearchParams({limit:'24',...(tag?{tag}:{})});
 const list=usePagedResource<WorldListItem>('v1/worlds?'+params,worldsRevision+sessionsRevision);
 const tags=useResource<{items:Tag[]}>('v1/worlds/tags',worldsRevision);
 const filter=(tag:string)=>setQuery(tag?{tag}:{});
 async function importWorld(file:File){
  if(pending.current)return;pending.current=true;setImporting(true);setError('');
  try{const body=new FormData();body.set('file',file);const {item}=await api<{item:WorldDetail}>('v1/worlds/import',{method:'POST',body});refreshWorlds();navigate('/worlds/'+encodeURIComponent(item.id));}
  catch(reason){setError(reason instanceof ApiError&&['SERVER_UNAVAILABLE','INVALID_RESPONSE'].includes(reason.errorCode)?t('theImportResultCouldNotBeConfirmed'):reason instanceof Error?reason:t('importFailed'));}
  finally{pending.current=false;setImporting(false);}
 }
 return <section className={styles.page}>
  <PageHeader title={t('worlds')} actions={<UploadButton variant="primary" icon={<Upload size={16}/>} loading={importing} aria-label={t('importWorld')} accept=".json,.zip,application/json,application/zip,application/x-zip-compressed" onChange={e=>{const file=e.target.files?.[0];if(file)void importWorld(file);}}>{t('importWorld')}</UploadButton>}/>
  <WorldCleanupNotice/>
  {error&&<div className={styles.importError}><ErrorNotice message={error}/><Button onClick={()=>{refreshWorlds();setError('');}}>{t('refreshList')}</Button></div>}

  <div className={styles.body}>
   <nav className={styles.categories} aria-label={t('worldTags')}>
    <button className={[styles.category,!tag?styles.categoryActive:''].join(' ')} aria-pressed={!tag} onClick={()=>filter('')}>{t('all')}</button>
    {tag&&!tags.value?.items.some(item=>item.name===tag)&&<button className={[styles.category,styles.categoryActive].join(' ')} aria-pressed>{t('current')}{tag}</button>}
    {tags.value?.items.map(item=><button key={item.name} className={[styles.category,tag===item.name?styles.categoryActive:''].join(' ')} aria-pressed={tag===item.name} onClick={()=>filter(item.name)}>{item.name}</button>)}
    {tags.error&&<ErrorNotice message={tags.error} onRetry={tags.reload}/>}
   </nav>
   <div className={styles.galleryArea}>
    {list.loading&&!list.page&&<div className={styles.empty} role="status">{t('loadingWorlds')}</div>}
    {list.error&&<ErrorNotice message={list.error} onRetry={()=>list.page?void list.more():list.reload()}/>}
    <div className={styles.gallery}>{list.page?.items.map(world=><WorldCard key={world.id} world={world} onClick={()=>navigate('/worlds/'+encodeURIComponent(world.id)+'?'+new URLSearchParams({library:query.toString()}))}/>)}</div>
    {!list.loading&&!list.error&&list.page?.items.length===0&&<div className={styles.empty}><Info size={20}/><strong>{tag?t('noWorldsInThisCategory'):t('noWorldsYet')}</strong>{tag&&<Button onClick={()=>filter('')}>{t('viewAll')}</Button>}</div>}
    {list.page?.hasMore&&<Button className={styles.loadMore} loading={list.loading} onClick={()=>void list.more()}>{t('loadMore')}</Button>}
   </div>
  </div>
 </section>;
}
