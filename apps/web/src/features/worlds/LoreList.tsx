import {useTranslation} from 'react-i18next';
import {useId,useMemo,useState} from 'react';
import {ChevronRight} from 'lucide-react';
import {WorldDocumentRenderer} from '@sillyrealms/sdk/world-document';
import type {LoreEntry} from './api/worlds';
import {Badge} from '../../components/ui/Field';
import {loreStateReferences,stateReferencePath} from './lore-condition';
import styles from './WorldDetailPage.module.css';

export function LoreList({entries}:{entries:LoreEntry[]}){
  const {t} = useTranslation('worlds');
  const scopeLabels={global:t('global'),session:t('session'),message:t('message')} as const;
 const [expanded,setExpanded]=useState<string|null>(null),prefix=useId();
 const rows=useMemo(()=>entries.map(entry=>{
  const when=entry.load?.when;
  return {entry,when,references:when===undefined?null:loreStateReferences(when)};
 }),[entries]);
 if(!entries.length)return <p>{t('thisWorldHasNoLorebookEntriesYet')}</p>;
 return <><div className={styles.loreHeader}><span>{t('worlds:loreCount',{count:entries.length})}</span><span className={styles.loreMetadata}><span>{t('trigger')}</span><span title={t('activeEntriesAreAddedToThePreset')}>{t('insertionPoint')}</span><span>{t('status')}</span></span><span/></div><div className={styles.loreList}>{rows.map(({entry,when,references},index)=>{
  const mode=entry.load?.mode??'always',enabled=entry.enabled!==false&&mode!=='never',open=expanded===entry.id;
  const panelId=prefix+'-'+index;
  return <section key={entry.id} className={styles.loreItem} data-lore-entry={entry.id}>
   <button id={panelId+'-toggle'} className={styles.loreToggle} aria-expanded={open} aria-controls={panelId} onClick={()=>setExpanded(open?null:entry.id)}>
    <span className={styles.loreTitle}>{entry.title||t('untitledEntry')}{!open&&!!references?.length&&<Badge>{t('stateLinked')}</Badge>}</span>
    <span className={styles.loreMetadata}><span title={entry.load?.keywords?.join('、')} aria-label={t('worlds:triggerMode',{mode:t(mode==='always'?'worlds:always':mode==='on_mention'?'worlds:keywords':'worlds:never')})}>{mode==='always'?t('always'):mode==='on_mention'?t('keywords'):t('never')}</span><span title={t('presetLorebookNode')} aria-label={t('insertionPointLorebook')}>{t('lorebook')}</span><span data-enabled={enabled}>{enabled?t('enabled'):t('disabled')}</span></span>
    <ChevronRight size={17} className={open?styles.loreChevronOpen:''}/>
   </button>
   {open&&<div id={panelId} role="region" aria-labelledby={panelId+'-toggle'} tabIndex={0} className={styles.loreContent} onWheel={event=>event.stopPropagation()} onTouchMove={event=>event.stopPropagation()} onKeyDown={event=>event.stopPropagation()}>
    {when!==undefined&&<dl className={styles.loreCondition}>
     <dt>{t('linkedState')}</dt>
     <dd>{references?.length?<ul>{references.map(ref=><li key={JSON.stringify(ref)}>
      <span>{ref.scope?scopeLabels[ref.scope]:t('automatic')}</span> · {stateReferencePath(ref.path)}
     </li>)}</ul>:references===null?t('cannotParseLinkedState'):t('noStateReferences')}</dd>
     <dt>{t('originalExpression')}</dt><dd><pre><code>{when}</code></pre></dd>
    </dl>}
    <WorldDocumentRenderer showStyleWarning={false} title={entry.title||t('lorebookEntry')} content={entry.content}/>
   </div>}
  </section>;
 })}</div></>;
}
