import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {useTranslation} from 'react-i18next';
import {History,RefreshCw,ExternalLink} from 'lucide-react';
import DOMPurify from 'dompurify';
import {marked} from 'marked';
import {Button,IconButton,ActionLink} from '../../components/ui/Button';
import {Modal} from '../../components/ui/Modal';
import {ErrorNotice} from '../../app/ui';
import {ApiError} from '../../api';
import {errorMessage} from '../../i18n/errors';
import {formatDate,formatNumber} from '../../i18n/format';
import type {WorldDetail,WorldRelease,WorldVersionsView} from './api/worlds';
import {createWorldVersionsController,hasWorldUpdate,publicationLink,releaseDirection} from './versions';
import styles from './WorldPublication.module.css';

export function WorldUpdateDot({version}:{version:string}){
  const {t}=useTranslation('worlds');
  const label=t('publication.updateAvailable',{version});
  return <span className={styles.updateDot} role="img" aria-label={label} title={label}/>;
}

/** Author notes allow basic document markup, never styles, embeds or executable HTML. */
function ReleaseNotes({text}:{text:string}){
  const html=useMemo(()=>{
    const safe=DOMPurify.sanitize(marked.parse(text,{async:false}),{
      ALLOWED_TAGS:['p','br','strong','em','del','ul','ol','li','code','pre','blockquote','h1','h2','h3','h4','a','hr'],
      ALLOWED_ATTR:['href','title'],ALLOW_DATA_ATTR:false,
    });
    const template=document.createElement('template');template.innerHTML=safe;
    for(const link of template.content.querySelectorAll('a')){
      const href=publicationLink(link.getAttribute('href')??undefined);
      if(href){link.href=href;link.target='_blank';link.rel='noopener noreferrer';}
      else link.removeAttribute('href');
    }
    return template.innerHTML;
  },[text]);
  return <div className={styles.notes} dangerouslySetInnerHTML={{__html:html}}/>;
}
function packageSize(bytes:number){
  const unit=bytes>=1_000_000?'MB':bytes>=1_000?'KB':'B';
  return formatNumber(bytes/(unit==='MB'?1_000_000:unit==='KB'?1_000:1),{maximumFractionDigits:1})+' '+unit;
}
function VersionError({reason}:{reason:unknown}){
  const {t}=useTranslation('worlds');
  if(!reason)return null;
  const detail=reason instanceof ApiError&&reason.status!==undefined&&reason.status>=400&&reason.status<500&&
    reason.errorCode.startsWith('WORLD_')&&reason.errorMessage!==errorMessage(reason)?reason.errorMessage:null;
  return <div className={styles.failure}><ErrorNotice message={reason}/>
    {detail&&<details><summary>{t('publication.errorDetails')}</summary><p>{detail}</p></details>}
  </div>;
}

type Props={world:WorldDetail;onSummary:(view:WorldVersionsView)=>void;onApplied:(world:WorldDetail)=>void};
export function WorldPublication(props:Props){
  const callbacks=useRef(props);callbacks.current=props;
  const [controller,setController]=useState<ReturnType<typeof createWorldVersionsController>|null>(null);
  useEffect(()=>{
    const current=createWorldVersionsController(props.world.id,{
      onSummary:value=>callbacks.current.onSummary(value),onApplied:value=>callbacks.current.onApplied(value),
    });
    setController(current);return()=>current.dispose();
  },[props.world.id]);
  return controller?<PublicationContent world={props.world} controller={controller}/>:null;
}
function PublicationContent({world,controller}:{world:WorldDetail;controller:ReturnType<typeof createWorldVersionsController>}){
  const {t}=useTranslation('worlds');
  const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
  const [open,setOpen]=useState(false);
  const [selected,setSelected]=useState<{release:WorldRelease;revision:number;from:string|null}|null>(null);
  const publication=world.publication,view=state.view,summary=view??world;
  const hasSource=!!publication.update_url;
  const refreshing=state.refreshing,applying=!!state.applying,busy=state.loading||refreshing||applying;
  const refreshLabel=t(view?.lastSuccessAt?'publication.refreshVersions':'publication.getVersions');
  const showVersions=()=>{setSelected(null);setOpen(true);void controller.load();};
  const refresh=()=>{setOpen(true);setSelected(null);void controller.refresh();};
  const close=()=>{setOpen(false);setSelected(null);};
  const apply=async()=>{
    if(!selected)return;
    const success=await controller.apply({version:selected.release.version,expectedSha256:selected.release.artifact.sha256,expectedRevision:selected.revision});
    if(success)close();
  };
  const targetDirection=selected?releaseDirection(selected.from,selected.release.version):null;
  const actionLabel=selected?t(targetDirection==='downgrade'?'publication.downgradeTo':'publication.updateTo',{version:selected.release.version}):'';
  const homepage=publicationLink(publication.homepage);
  return <>
    <div className={styles.summary}>
      <span className={styles.authors} title={publication.authors.map(author=>author.name).join(' · ')}>
        {publication.authors.map((author,index)=>{
          const href=publicationLink(author.url);
          return <span key={index}>{index>0&&' · '}{href?<a href={href} target="_blank" rel="noopener noreferrer">{author.name}</a>:author.name}</span>;
        })}
      </span>
      <Button size="compact" variant="ghost" onClick={showVersions} icon={<History size={14}/>} aria-label={t('publication.versions')}>
        {'v'+publication.release.version}
        {hasWorldUpdate(summary)&&<WorldUpdateDot version={summary.latestVersion!}/>}
      </Button>
      <IconButton size="compact" aria-label={refreshLabel} title={hasSource?refreshLabel:t('publication.noSource')}
        disabled={!hasSource||applying} loading={refreshing} onClick={refresh}><RefreshCw size={14}/></IconButton>
    </div>
    {open&&<Modal title={selected?t('publication.confirmTitle'):t('publication.versions')} size="editor" mobileSheet
      onClose={close} onBeforeClose={()=>!applying}
      footer={selected?<>
        <Button disabled={applying} onClick={()=>{setSelected(null);controller.clearError();}}>{t('cancel')}</Button>
        <Button variant="primary" loading={applying} onClick={()=>void apply()}>{applying?t('publication.applying'):actionLabel}</Button>
      </>:<Button onClick={close}>{t('common:closeDialog')}</Button>}>
      <div className={styles.dialog}>
        {selected?<>
          <p>{t('publication.confirmCopy',{from:selected.from??t('publication.undeclared'),to:selected.release.version})}</p>
          <p className={styles.hint}>{t('publication.confirmPreserved')}</p>
          <div className={styles.releaseTitle}><strong>v{selected.release.version}</strong>{selected.release.title&&<span>{selected.release.title}</span>}</div>
          <ReleaseNotes text={selected.release.notes||t('publication.noNotes')}/>
          <VersionError reason={state.error}/>
        </>:<>
          <section className={styles.installed} aria-label={t('publication.installed')}>
            <div className={styles.installedHeader}><span>{t('publication.installed')}</span><strong>{summary.currentVersion?'v'+summary.currentVersion:t('publication.undeclared')}</strong>
              {homepage&&<ActionLink href={homepage} target="_blank" rel="noopener noreferrer" size="compact" variant="ghost">{t('publication.homepage')} <ExternalLink size={13}/></ActionLink>}
            </div>
            <>
              <p className={styles.hint}>{t('publication.authors')} {publication.authors.map(author=>author.name).join(' · ')}</p>
              {publication.creator_notes&&<details><summary>{t('publication.creatorNotes')}</summary><ReleaseNotes text={publication.creator_notes}/></details>}
              <details><summary>{t('publication.installedNotes')}</summary>
                <p className={styles.hint}>{formatDate(publication.release.published_at,{dateStyle:'medium',timeStyle:'short'})}</p>
                <ReleaseNotes text={publication.release.notes||t('publication.noNotes')}/>
              </details>
            </>
          </section>
          <div className={styles.toolbar}>
            <div className={styles.hint}>
              {view?.lastSuccessAt?t('publication.lastFetched',{time:formatDate(view.lastSuccessAt,{dateStyle:'medium',timeStyle:'short'})}):
                hasSource?t('publication.notFetched'):t('publication.noSource')}
            </div>
            <Button size="compact" disabled={!hasSource||state.loading||applying} loading={refreshing}
              icon={<RefreshCw size={14}/>} onClick={()=>void controller.refresh()}>{refreshLabel}</Button>
          </div>
          {state.loading&&<p role="status" className={styles.hint}>{t('publication.loadingLocal')}</p>}
          {(refreshing||view?.updateStatus==='checking')&&<p role="status" className={styles.hint}>{t('publication.fetching')}</p>}
          <VersionError reason={state.error||view?.errorCode}/>
          {state.error&&!view&&<Button size="compact" onClick={()=>void controller.load()}>{t('retry')}</Button>}
          {view?.lastSuccessAt!==null&&view?.lastSuccessAt!==undefined&&view.versions.length===0&&<p className={styles.empty}>{t('publication.empty')}</p>}
          {view&&view.versions.length>0&&<ol className={styles.releases} aria-label={t('publication.publishedVersions')}>
            {view.versions.map(release=>{
              const direction=releaseDirection(summary.currentVersion,release.version);
              const label=direction==='current'?t('publication.current'):!release.supported?t('publication.requiresAppUpdate'):
                t(direction==='downgrade'?'publication.downgradeTo':'publication.updateTo',{version:release.version});
              return <li key={release.version} className={styles.release}>
                <div className={styles.releaseHeader}>
                  <div className={styles.releaseTitle}><strong>v{release.version}</strong>{release.title&&<span>{release.title}</span>}</div>
                  <Button size="compact" disabled={busy||!release.supported||!direction||direction==='current'}
                    onClick={()=>{controller.clearError();setSelected({release,revision:world.revision,from:summary.currentVersion});}}>{label}</Button>
                </div>
                <p className={styles.hint}>{formatDate(release.published_at,{dateStyle:'medium'})} · {packageSize(release.artifact.size_bytes)} · {release.artifact.format.toUpperCase()}</p>
                <ReleaseNotes text={release.notes||t('publication.noNotes')}/>
              </li>;
            })}
          </ol>}
        </>}
      </div>
    </Modal>}
  </>;
}
