import {PageHeader} from '../../components/ui/PageHeader';
import {Button,UploadButton} from '../../components/ui/Button';
import {useEffect,useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {Info,Upload} from 'lucide-react';
import {listTags,listWorlds,type Tag} from './api/worlds';
import {api} from '../../api';
import {usePaged} from './api/usePaged';
import {WorldCard} from './WorldCard';
import styles from './WorldLibraryPage.module.css';

export function WorldLibraryPage(){
  const [category,setCategory]=useState('');
  const [importing,setImporting]=useState(false),[importError,setImportError]=useState('');
  async function importWorld(file:File){setImporting(true);setImportError('');try{const body=new FormData();body.set('file',file);const result=await api('v1/worlds/import',{method:'POST',body});navigate('/worlds/'+encodeURIComponent(result.item.id));}catch(error){setImportError(error instanceof Error?error.message:'导入失败');}finally{setImporting(false);}}
  const [tags,setTags]=useState<Tag[]>([]);
  const [tagsError,setTagsError]=useState(false);
  const [tagRevision,setTagRevision]=useState(0);
  const navigate=useNavigate();
  const {page,loading,error,more,retry}=usePaged(category,(cursor,signal)=>listWorlds(category,cursor,signal));
  useEffect(()=>{const c=new AbortController();setTagsError(false);listTags(c.signal).then(data=>setTags(data.items)).catch(()=>{if(!c.signal.aborted)setTagsError(true);});return()=>c.abort();},[tagRevision]);
  return <div className={styles.page}>
    <PageHeader title="世界卡" actions={<UploadButton variant="primary" icon={<Upload size={16}/>} loading={importing} aria-label="导入世界卡" accept=".json,.zip,application/json,application/zip,application/x-zip-compressed" onChange={event=>{const file=event.target.files?.[0];if(file)void importWorld(file);}}>导入世界卡</UploadButton>}/>
    <div className={styles.body}>{importError&&<p role="alert">{importError}</p>}
      <nav className={styles.categories} aria-label="世界分类">
        {[{id:'',name:'全部'},...tags].map(tag=><button className={[styles.category,category===tag.id?styles.categoryActive:''].join(' ')} key={tag.id} onClick={()=>setCategory(tag.id)} aria-pressed={category===tag.id}>{tag.name}</button>)}
        {tagsError&&<button className={styles.category} onClick={()=>setTagRevision(n=>n+1)}>标签加载失败，重试</button>}
      </nav>
      <div className={styles.galleryArea}>
        {page&&page.items.length>0&&<div className={styles.gallery}>{page.items.map(world=><WorldCard key={world.id} world={world} onClick={()=>navigate('/worlds/'+encodeURIComponent(world.id))}/>)}</div>}
        {loading&&!page&&<div className={styles.empty} role="status">正在加载世界卡…</div>}
        {error&&<div className={styles.empty} role="alert"><strong>无法加载世界卡</strong><span>请检查服务连接后重试。</span><Button onClick={retry}>重试</Button></div>}
        {!loading&&!error&&page?.items.length===0&&<div className={styles.empty}><Info size={20}/><strong>{category?'该分类暂时没有世界卡':'还没有世界卡'}</strong>{category&&<Button onClick={()=>setCategory('')}>查看全部</Button>}</div>}
        {page?.hasMore&&!error&&<Button className={styles.loadMore} disabled={loading} onClick={more}>{loading?'加载中…':'加载更多'}</Button>}
      </div>
    </div>
  </div>;
}
