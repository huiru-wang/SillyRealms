import {useEffect,useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {Info} from 'lucide-react';
import {listTags,listWorlds,type Tag} from './api/worlds';
import {usePaged} from './api/usePaged';
import {WorldCard} from './WorldCard';
import styles from './WorldLibraryPage.module.css';

export function WorldLibraryPage(){
  const [category,setCategory]=useState('');
  const [tags,setTags]=useState<Tag[]>([]);
  const [tagsError,setTagsError]=useState(false);
  const [tagRevision,setTagRevision]=useState(0);
  const navigate=useNavigate();
  const {page,loading,error,more,retry}=usePaged(category,(cursor,signal)=>listWorlds(category,cursor,signal));
  useEffect(()=>{const c=new AbortController();setTagsError(false);listTags(c.signal).then(data=>setTags(data.items)).catch(()=>{if(!c.signal.aborted)setTagsError(true);});return()=>c.abort();},[tagRevision]);
  return <div className={styles.page}>
    <header className={styles.header}><h1>世界卡</h1>{import.meta.env.VITE_STUDIO_MOCK_DATA==='1'&&<span className={styles.mockLabel}>模拟数据</span>}</header>
    <div className={styles.body}>
      <nav className={styles.categories} aria-label="世界分类">
        {[{id:'',name:'全部'},...tags].map(tag=><button className={[styles.category,category===tag.id?styles.categoryActive:''].join(' ')} key={tag.id} onClick={()=>setCategory(tag.id)} aria-pressed={category===tag.id}>{tag.name}</button>)}
        {tagsError&&<button className={styles.category} onClick={()=>setTagRevision(n=>n+1)}>标签加载失败，重试</button>}
      </nav>
      <div className={styles.galleryArea}>
        {page&&page.items.length>0&&<div className={styles.gallery}>{page.items.map(world=><WorldCard key={world.id} world={world} onClick={()=>navigate('/worlds/'+encodeURIComponent(world.id))}/>)}</div>}
        {loading&&!page&&<div className={styles.empty} role="status">正在加载世界卡…</div>}
        {error&&<div className={styles.empty} role="alert"><strong>无法加载世界卡</strong><span>请检查服务连接后重试。</span><button onClick={retry}>重试</button></div>}
        {!loading&&!error&&page?.items.length===0&&<div className={styles.empty}><Info size={20}/><strong>{category?'该分类暂时没有世界卡':'还没有世界卡'}</strong>{category&&<button onClick={()=>setCategory('')}>查看全部</button>}</div>}
        {page?.hasMore&&!error&&<button className={styles.loadMore} disabled={loading} onClick={more}>{loading?'加载中…':'加载更多'}</button>}
      </div>
    </div>
  </div>;
}
