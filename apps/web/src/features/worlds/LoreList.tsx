import {useId,useMemo,useState} from 'react';
import {ChevronRight} from 'lucide-react';
import {WorldDocumentRenderer} from '@sillyrealms/sdk/world-document';
import type {LoreEntry} from './api/worlds';
import {Badge} from '../../components/ui/Field';
import {loreStateReferences,stateReferencePath} from './lore-condition';
import styles from './WorldDetailPage.module.css';

const scopeLabels={global:'全局',session:'会话',message:'消息'} as const;
export function LoreList({entries}:{entries:LoreEntry[]}){
 const [expanded,setExpanded]=useState<string|null>(null),prefix=useId();
 const rows=useMemo(()=>entries.map(entry=>{
  const when=entry.load?.when;
  return {entry,when,references:when===undefined?null:loreStateReferences(when)};
 }),[entries]);
 if(!entries.length)return <p>这个世界还没有世界书条目。</p>;
 return <><div className={styles.loreHeader}><span>{entries.length} 个条目</span><span className={styles.loreMetadata}><span>触发策略</span><span title="激活条目统一加入预设的世界书节点">插入位置</span><span>状态</span></span><span/></div><div className={styles.loreList}>{rows.map(({entry,when,references},index)=>{
  const mode=entry.load?.mode??'always',enabled=entry.enabled!==false&&mode!=='never',open=expanded===entry.id;
  const panelId=prefix+'-'+index;
  return <section key={entry.id} className={styles.loreItem} data-lore-entry={entry.id}>
   <button id={panelId+'-toggle'} className={styles.loreToggle} aria-expanded={open} aria-controls={panelId} onClick={()=>setExpanded(open?null:entry.id)}>
    <span className={styles.loreTitle}>{entry.title||'未命名条目'}{!open&&!!references?.length&&<Badge>状态关联</Badge>}</span>
    <span className={styles.loreMetadata}><span title={entry.load?.keywords?.join('、')} aria-label={'触发策略：'+(mode==='always'?'常驻':mode==='on_mention'?'关键字':'不加载')}>{mode==='always'?'常驻':mode==='on_mention'?'关键字':'不加载'}</span><span title="预设世界书节点" aria-label="插入位置：世界书">世界书</span><span data-enabled={enabled}>{enabled?'已开启':'已关闭'}</span></span>
    <ChevronRight size={17} className={open?styles.loreChevronOpen:''}/>
   </button>
   {open&&<div id={panelId} role="region" aria-labelledby={panelId+'-toggle'} tabIndex={0} className={styles.loreContent} onWheel={event=>event.stopPropagation()} onTouchMove={event=>event.stopPropagation()} onKeyDown={event=>event.stopPropagation()}>
    {when!==undefined&&<dl className={styles.loreCondition}>
     <dt>关联状态</dt>
     <dd>{references?.length?<ul>{references.map(ref=><li key={JSON.stringify(ref)}>
      <span>{ref.scope?scopeLabels[ref.scope]:'自动查找'}</span> · {stateReferencePath(ref.path)}
     </li>)}</ul>:references===null?'无法解析关联状态':'未引用状态'}</dd>
     <dt>原始表达式</dt><dd><pre><code>{when}</code></pre></dd>
    </dl>}
    <WorldDocumentRenderer showStyleWarning={false} title={entry.title||'世界书条目'} content={entry.content}/>
   </div>}
  </section>;
 })}</div></>;
}
