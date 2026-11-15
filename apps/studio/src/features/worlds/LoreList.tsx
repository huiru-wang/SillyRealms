import {useId,useState} from 'react';
import {ChevronRight} from 'lucide-react';
import {WorldDocumentRenderer} from '@sillyrealms/sdk';
import type {LoreEntry} from './api/worlds';
import styles from './WorldDetailPage.module.css';

// Primary: entry title; secondary: policy/position/status; tertiary: isolated body.
// Existing text/stroke tokens, 320px reading pane, no additional action hierarchy (§2.2, §3.6).
const anchors={personaInfo:'玩家设定',characterInfo:'角色设定',worldState:'世界状态',userInput:'当前输入'};
export function LoreList({entries}:{entries:LoreEntry[]}){
 const [expanded,setExpanded]=useState<string|null>(null),prefix=useId();
 if(!entries.length)return <p>这个世界还没有世界书条目。</p>;
 return <><div className={styles.loreHeader}><span>{entries.length} 个条目</span><span className={styles.loreMetadata}><span>触发策略</span><span title="Agent 使用所列位置；Direct 统一插入世界信息">插入位置</span><span>状态</span></span><span/></div><div className={styles.loreList}>{entries.map((entry,index)=>{
  const mode=entry.load?.mode??'always',enabled=entry.enabled!==false&&mode!=='never',open=expanded===entry.id;
  const position=anchors[entry.load?.anchor??'characterInfo']+(entry.load?.position==='before'?'前':'后');
  const panelId=prefix+'-'+index;
  return <section key={entry.id} className={styles.loreItem} data-lore-entry={entry.id}>
   <button id={panelId+'-toggle'} className={styles.loreToggle} aria-expanded={open} aria-controls={panelId} onClick={()=>setExpanded(open?null:entry.id)}>
    <span className={styles.loreTitle}>{entry.title||'未命名条目'}</span>
    <span className={styles.loreMetadata}><span title={entry.load?.keywords?.join('、')} aria-label={'触发策略：'+(mode==='always'?'常驻':mode==='on_mention'?'关键字':'不加载')}>{mode==='always'?'常驻':mode==='on_mention'?'关键字':'不加载'}</span><span title={'Agent：'+position+'；Direct：世界信息'} aria-label={'插入位置：'+position}>{position}</span><span data-enabled={enabled}>{enabled?'已开启':'已关闭'}</span></span>
    <ChevronRight size={17} className={open?styles.loreChevronOpen:''}/>
   </button>
   {open&&<div id={panelId} role="region" aria-labelledby={panelId+'-toggle'} tabIndex={0} className={styles.loreContent} onWheel={event=>event.stopPropagation()} onTouchMove={event=>event.stopPropagation()} onKeyDown={event=>event.stopPropagation()}><WorldDocumentRenderer showStyleWarning={false} title={entry.title||'世界书条目'} content={entry.content}/></div>}
  </section>;
 })}</div></>;
}
