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
 const [query,setQuery]=useSearchParams(),navigate=useNavigate();
 const tag=query.get('tag')??'';
 const [importing,setImporting]=useState(false),[error,setError]=useState('');
 const pending=useRef(false);const {worldsRevision,sessionsRevision,refreshWorlds}=useManagement();
 const params=new URLSearchParams({limit:'24',...(tag?{tag}:{})});
 const list=usePagedResource<WorldListItem>('v1/worlds?'+params,worldsRevision+sessionsRevision);
 const tags=useResource<{items:Tag[]}>('v1/worlds/tags',worldsRevision);
 const filter=(tag:string)=>setQuery(tag?{tag}:{});
 async function importWorld(file:File){
  if(pending.current)return;pending.current=true;setImporting(true);setError('');
  try{const body=new FormData();body.set('file',file);const {item}=await api<{item:WorldDetail}>('v1/worlds/import',{method:'POST',body});refreshWorlds();navigate('/worlds/'+encodeURIComponent(item.id));}
  catch(reason){setError(reason instanceof ApiError&&['SERVER_UNAVAILABLE','INVALID_RESPONSE'].includes(reason.errorCode)?'未能确认导入结果，请先刷新列表检查，避免重复导入。':reason instanceof Error?reason.message:'导入失败');}
  finally{pending.current=false;setImporting(false);}
 }
 return <section className={styles.page}>
  <PageHeader title="世界卡" actions={<UploadButton variant="primary" icon={<Upload size={16}/>} loading={importing} aria-label="导入世界卡" accept=".json,.zip,application/json,application/zip,application/x-zip-compressed" onChange={e=>{const file=e.target.files?.[0];if(file)void importWorld(file);}}>导入世界卡</UploadButton>}/>
  <WorldCleanupNotice/>
  {error&&<div className={styles.importError}><ErrorNotice message={error}/><Button onClick={()=>{refreshWorlds();setError('');}}>刷新列表</Button></div>}

  <div className={styles.body}>
   <nav className={styles.categories} aria-label="世界标签">
    <button className={[styles.category,!tag?styles.categoryActive:''].join(' ')} aria-pressed={!tag} onClick={()=>filter('')}>全部</button>
    {tag&&!tags.value?.items.some(item=>item.name===tag)&&<button className={[styles.category,styles.categoryActive].join(' ')} aria-pressed>当前：{tag}</button>}
    {tags.value?.items.map(item=><button key={item.name} className={[styles.category,tag===item.name?styles.categoryActive:''].join(' ')} aria-pressed={tag===item.name} onClick={()=>filter(item.name)}>{item.name}</button>)}
    {tags.error&&<ErrorNotice message={tags.error} onRetry={tags.reload}/>}
   </nav>
   <div className={styles.galleryArea}>
    {list.loading&&!list.page&&<div className={styles.empty} role="status">正在加载世界卡…</div>}
    {list.error&&<ErrorNotice message={list.error} onRetry={()=>list.page?void list.more():list.reload()}/>}
    <div className={styles.gallery}>{list.page?.items.map(world=><WorldCard key={world.id} world={world} onClick={()=>navigate('/worlds/'+encodeURIComponent(world.id)+'?'+new URLSearchParams({library:query.toString()}))}/>)}</div>
    {!list.loading&&!list.error&&list.page?.items.length===0&&<div className={styles.empty}><Info size={20}/><strong>{tag?'该分类暂时没有世界卡':'还没有世界卡'}</strong>{tag&&<Button onClick={()=>filter('')}>查看全部</Button>}</div>}
    {list.page?.hasMore&&<Button className={styles.loadMore} loading={list.loading} onClick={()=>void list.more()}>加载更多</Button>}
   </div>
  </div>
 </section>;
}
