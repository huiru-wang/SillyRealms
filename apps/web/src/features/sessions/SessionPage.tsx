import {useManagement} from '../../app/ManagementData';
import {errorKey,errorMessage} from '../../i18n/errors.ts';
import {useTranslation} from 'react-i18next';
import {i18n} from '../../i18n/instance.ts';
import {useCallback,useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {ArrowLeft,ChevronDown,ChevronUp,Send,Square,Settings2} from 'lucide-react';
import {Link} from 'react-router-dom';
import {trimTrailingEmptyRoleplayLines} from '@sillyrealms/roleplay';
import {RoleplayComposer} from './composer/RoleplayComposer';
import {SessionTokenUsage} from './SessionTokenUsage';
import {SessionConfiguration} from './SessionConfiguration';
import {ComposerMoreMenu} from './ComposerMoreMenu';
import {Button} from '../../components/ui/Button';
import type {HostedComposerButton} from '../../stage-host/composer-buttons';
import {StageHost} from '../../stage-host/StageHost';
import {createSessionWorkspace,type SessionWorkspace} from './workspace';
import {useSessionLayout} from './use-session-layout';
import type {StageCommand} from '../../../../../packages/sr-sdk/src/stage-contract';
import styles from './Sessions.module.css';

export function SessionPage({id}:{id:string}){
  useTranslation();
  const [workspace,setWorkspace]=useState<SessionWorkspace|null>(null),[attempt,setAttempt]=useState(0);
  useEffect(()=>{const current=createSessionWorkspace(id);setWorkspace(current);void current.start();return()=>current.dispose();},[id,attempt]);
  return workspace?<SessionView key={id} workspace={workspace} reload={()=>setAttempt(value=>value+1)}/>:<p className="loading-panel" role="status">{i18n.t("sessions:loading")}</p>;
}
function SessionView({workspace,reload}:{workspace:SessionWorkspace;reload:()=>void}){
  useTranslation();
  const view=useSyncExternalStore(workspace.subscribe,workspace.getSnapshot,workspace.getSnapshot);
  const {stage,session}=view,layout=useSessionLayout();
  const {localeSaving}=useManagement();
  const [draft,setDraft]=useState(''),[expanded,setExpanded]=useState(true),[notice,setNotice]=useState(''),[settingsOpen,setSettingsOpen]=useState(false),[fontSize,setFontSize]=useState(16);
  const [buttons,setButtons]=useState<HostedComposerButton[]>([]);
  const revision=useRef(0),draftRef=useRef(draft),expandButton=useRef<HTMLButtonElement>(null);draftRef.current=draft;
  const updateDraft=useCallback((text:string)=>{revision.current++;draftRef.current=text;setDraft(text);},[]);
  useEffect(()=>{
    let size=16;try{const stored=Number(localStorage.getItem('sr:session:'+stage.sessionId+':reading-font-size'));if(Number.isInteger(stored)&&stored>=13&&stored<=21)size=stored;}catch{/* Optional browser preference. */}setFontSize(size);
  },[stage.sessionId]);
  useEffect(()=>{if(!expanded)expandButton.current?.focus();},[expanded]);
  const command=useCallback<StageCommand>(async(method,input)=>{
    if(localeSaving&&(method==='narrative.send'||method==='narrative.regenerate'))throw Error('settings:savingLanguage');
    if(method==='composer.setDraft'){updateDraft((input as {text:string}).text);setExpanded(true);return undefined as never;}
    return workspace.command(method,input);
  },[workspace,updateDraft,localeSaving]);
  const render=useMemo(()=>view.world&&view.config?{
    modules:view.world.modules,main:view.world.main,rules:view.world.rules,state:view.world.state,assetBaseUrl:view.world.assetBaseUrl,debug:view.config.debug,
  }:null,[view.world,view.config]);
  const activeRun=stage.activeRunId,active=stage.runs.find(run=>run.runId===activeRun);
  const busy=!!activeRun||view.sending||localeSaving;
  const latestRun=stage.runs.at(-1),latestUser=latestRun?.messages.find(message=>message.role==='user');
  const latestReply=latestRun?.messages.at(-1);
  const canRegenerate=!!latestUser&&!!session&&!busy&&stage.connected&&!stage.history.loading&&!stage.history.error;
  const regenerate=async()=>{
    if(!canRegenerate||!latestUser)return;
    setNotice('');
    try{await command('narrative.regenerate',{userEntryId:latestUser.id,assistantEntryId:latestReply?.role==='assistant'?latestReply.id:null});}
    catch(reason){setNotice(errorKey(reason,"sessions:regenerateFailed"));}
  };
  const label=!stage.connected?i18n.t("sessions:connecting"):activeRun?(active?.phase==='summarizing'?i18n.t("sessions:summarizing"):active?.phase==='preparing'?i18n.t("sessions:preparing"):view.stopping?i18n.t("sessions:stopping"):i18n.t("sessions:generating")):i18n.t("sessions:connected");
  const submit=async(value?:string)=>{
    if(busy||view.loading||!stage.connected||!session)return;
    const text=trimTrailingEmptyRoleplayLines(value??draftRef.current);if(!text.trim())return;
    const currentRevision=revision.current;setNotice('');
    try{await command('narrative.send',{text});if(revision.current===currentRevision)updateDraft('');}
    catch(reason){setNotice(errorKey(reason,"sessions:sendFailed"));}
  };
  const stop=async()=>{if(!activeRun||!view.stage.activeAssistantEntryId)return;try{await command('narrative.stop',{runId:activeRun,assistantEntryId:view.stage.activeAssistantEntryId});}catch(reason){setNotice(errorKey(reason,"sessions:stopFailed"));}};
  const error=errorMessage(notice||view.notice);
  const title=session?.title||session?.worldName||i18n.t("common:sessions");
  const titleHint=session?.worldName&&session.worldName!==title?title+' · '+session.worldName:title;
  return <section ref={layout.detail} className={styles.detail} data-session-detail={stage.sessionId}>
    <header className={styles.topbar} data-session-toolbar>
      <Link to="/sessions" className={styles.mobileBack} aria-label={i18n.t("sessions:backToList")}><ArrowLeft size={20}/></Link>
      <div className={styles.identity}><h1 title={titleHint}>{title}</h1></div>
      <div className={styles.topActions}>
        <SessionTokenUsage sessionId={stage.sessionId} refreshKey={view.usageRevision}/>
        <span className={styles.status} data-connected={stage.connected} role="status" title={label}><i aria-hidden="true"/><span>{label}</span></span>
        <button className={styles.iconButton} disabled={!session} aria-label={i18n.t("sessions:settings")} onClick={()=>setSettingsOpen(true)}><Settings2 size={18}/></button>
      </div>
    </header>
    <div ref={layout.viewport} className={styles.stageSlot} aria-label={i18n.t("sessions:stage")}>
      {view.error?<div className="stage-error" role="alert"><h2>{i18n.t("sessions:unavailable")}</h2><p>{errorMessage(view.error)}</p><button onClick={reload}>{i18n.t("sessions:reloadSession")}</button></div>:
        view.worldError?<div className="stage-error" role="alert"><h2>{i18n.t("sessions:worldLoadFailed")}</h2><p>{errorMessage(view.worldError)}</p><button onClick={()=>void workspace.reloadWorld()}>{i18n.t("sessions:reloadWorld")}</button></div>:
        render&&view.config?<StageHost config={view.config} render={render} snapshot={stage} command={command} subscribeEvents={workspace.subscribeEvents} fontSize={fontSize} bottomInset={layout.bottomInset} onNotice={setNotice} onComposerButtons={setButtons}/>:
        <p className="loading-panel" role="status">{i18n.t("sessions:preparingStage")}</p>}
    </div>
    <div ref={layout.overlay} className={styles.composerArea} data-composer-overlay>
      {error&&<div className={styles.previewError} role="alert">{error}<button type="button" aria-label={i18n.t("sessions:closeNotice")} onClick={()=>{setNotice('');workspace.clearNotice();}}>×</button></div>}
      {expanded&&buttons.length>0&&<div className={styles.composerButtons} role="group" aria-label={i18n.t("sessions:stageActions")}>
        {buttons.map(button=><Button key={button.id} size="compact" disabled={button.disabled} title={button.label}
          onClick={button.click}>{button.label}</Button>)}
      </div>}
      {expanded?<form className={styles.composer} aria-label={i18n.t("sessions:messageInput")} onSubmit={event=>{event.preventDefault();void submit();}}>
        <button type="button" className={styles.collapse} aria-label={i18n.t("sessions:collapseComposer")} onClick={()=>setExpanded(false)}><ChevronDown size={19}/></button>
        <ComposerMoreMenu canRegenerate={canRegenerate} onRegenerate={()=>void regenerate()}/>
        <div ref={layout.composer} className={styles.editor}><RoleplayComposer value={draft} disabled={false} onChange={updateDraft} onSubmit={text=>void submit(text)}/></div>
        {activeRun?<button className={styles.send} type="button" aria-label={i18n.t("sessions:stopGeneration")} disabled={view.stopping} onClick={()=>void stop()}><Square size={16}/></button>:
          <button className={styles.send} type="submit" aria-label={i18n.t("sessions:sendMessage")} disabled={view.loading||!session||!stage.connected||view.sending||!draft.trim()||draft.length>100000}><Send size={18}/></button>}
      </form>:<div className={styles.collapsedActions}>
        <button ref={expandButton} className={styles.expand} aria-label={i18n.t("sessions:expandComposer")} onClick={()=>{setExpanded(true);requestAnimationFrame(()=>layout.composer.current?.querySelector<HTMLElement>('.sr-composer-editor')?.focus());}}><ChevronUp size={19}/></button>
        {activeRun&&<button className={styles.stopCollapsed} aria-label={i18n.t("sessions:stopGeneration")} disabled={view.stopping} onClick={()=>void stop()}><Square size={16}/></button>}
      </div>}
    </div>
    {settingsOpen&&session&&<SessionConfiguration session={session} disabled={busy} fontSize={fontSize} onFontSize={setFontSize} onClose={()=>setSettingsOpen(false)} onSaved={workspace.updateSession}/>}
  </section>;
}
