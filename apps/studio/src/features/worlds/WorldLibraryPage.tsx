import {useCallback,useMemo,useState} from 'react';
import {Upload,Info} from 'lucide-react';
import {Button} from '../../components/ui/Button';
import {Modal} from '../../components/ui/Modal';
import {categories,worlds,type World,type WorldCategory} from '../../fixtures/worlds';
import {WorldCard} from './WorldCard';
import styles from './WorldLibraryPage.module.css';

export function WorldLibraryPage(){
  const [category,setCategory]=useState<WorldCategory|'全部'>('全部');
  const [selected,setSelected]=useState<World|null>(null);
  const [importOpen,setImportOpen]=useState(false);
  const closeImport=useCallback(()=>setImportOpen(false),[]);
  const closeDetail=useCallback(()=>setSelected(null),[]);
  const shown=useMemo(()=>category==='全部'?worlds:worlds.filter(w=>w.categories.includes(category)),[category]);
  return <div className={styles.page}>
    <header className={styles.header}>
      <h1>世界卡</h1>
      <Button icon={<Upload size={17} strokeWidth={1.8}/>} onClick={()=>setImportOpen(true)}>导入</Button>
    </header>
    <div className={styles.body}>
      <nav className={styles.categories} aria-label="世界分类">
        {(['全部',...categories] as const).map(cat=><button className={[styles.category,category===cat?styles.categoryActive:''].join(' ')} key={cat}
          onClick={()=>setCategory(cat)} aria-pressed={category===cat}>{cat}</button>)}
      </nav>
      <div className={styles.galleryArea}>
        {shown.length>0?
          <div className={styles.gallery}>{shown.map(world=><WorldCard key={world.id} world={world} onClick={()=>setSelected(world)}/>)}</div>
          :<div className={styles.empty}><Info size={20}/><strong>该分类暂时没有世界卡</strong><span>试试其他分类，或查看全部世界卡。</span><button onClick={()=>setCategory('全部')}>查看全部</button></div>
        }
      </div>
    </div>
    {importOpen&&<Modal title="导入世界卡" onClose={closeImport}>
      <p>设计预览模式：此处用于测试导入入口、弹窗尺寸、文字层级与操作反馈。</p>
      <p>当前工程不连接服务端，也不会读取或保存世界卡文件。</p>
      <div className={styles.demoNotice}>静态设计原型 · 暂未开放导入</div>
    </Modal>}
    {selected&&<Modal title={selected.title} onClose={closeDetail}>
      <div className={styles.previewHero}><img src={selected.cover} alt=""/></div>
      <p className={styles.previewGenre}>{selected.genre} · {selected.sessionCount} 个会话</p>
      <p>{selected.description}</p>
      <div className={styles.demoNotice}>世界详情页面将在设计基调确认后继续完善。</div>
    </Modal>}
  </div>;
}
