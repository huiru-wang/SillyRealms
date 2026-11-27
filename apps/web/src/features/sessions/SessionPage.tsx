import {createReplyAssistController} from '../reply-assist/controller';
import {Modal} from '../../components/ui/Modal';
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
import {ComposerActionRow,SpriteToggle} from './ComposerActionRow';
import {CharacterSpriteOverlay} from '../character-sprites/CharacterSpriteOverlay';
import type {HostedComposerButton} from '../../stage-host/composer-buttons';
import {StageHost} from '../../stage-host/StageHost';
import {createSessionWorkspace,type SessionWorkspace} from './workspace';
import {useSessionLayout} from './use-session-layout';
import {worldReleaseIdentity} from '../worlds/versions';
import type {StageCommand} from '../../../../../packages/sr-sdk/src/stage-contract';
import styles from './Sessions.module.css';

export function SessionPage({id}:{id:string}){
  useTranslation();
  const [workspace,setWorkspace]=useState<SessionWorkspace|null>(null),[attempt,setAttempt]=useState(0);
  useEffect(()=>{const current=createSessionWorkspace(id);setWorkspace(current);void current.start();return()=>current.dispose();},[id,attempt]);
  return workspace?.getSnapshot().stage.sessionId===id?<SessionView key={id} workspace={workspace} reload={()=>setAttempt(value=>value+1)}/>:<p className="loading-panel" role="status">{i18n.t("sessions:loading")}</p>;
}
function SessionView({workspace,reload}:{workspace:SessionWorkspace;reload:()=>void}){
  useTranslation();
  const view=useSyncExternalStore(workspace.subscribe,workspace.getSnapshot,workspace.getSnapshot);
  const {stage,session}=view,layout=useSessionLayout();
  const spriteToggle=view.capabilities?.characterSprite.available?{
    enabled:view.sprites.enabled,onToggle:()=>workspace.setSpritesEnabled(!view.sprites.enabled),
  }:null;
  const {localeSaving,settings}=useManagement();
  const assistPresetId=session?.runtimeConfig.replyAssistPresetId??settings.value?.item.defaultReplyAssistPresetId;
  const [draft,setDraft]=useState(''),[expanded,setExpanded]=useState(true),[notice,setNotice]=useState(''),[settingsOpen,setSettingsOpen]=useState(false),[previewFont,setPreviewFont]=useState<number|null>(null);
  const [buttons,setButtons]=useState<HostedComposerButton[]>([]);
  const revision=useRef(0),draftRef=useRef(draft),expandButton=useRef<HTMLButtonElement>(null);draftRef.current=draft;
  const updateDraft=useCallback((text:string)=>{revision.current++;draftRef.current=text;setDraft(text);},[]);
  const fontSize=previewFont??session?.runtimeConfig.fontSize??16;
  useEffect(()=>{if(!expanded)expandButton.current?.focus();},[expanded]);
  const [assistBusy,setAssistBusy]=useState(false),[assistError,setAssistError]=useState('');
  const reportAssist=useCallback((reason:unknown)=>{
    const key=errorKey(reason);
    setAssistError(key==='RUN_ALREADY_ACTIVE'?'sessions:assistNarrativeBusy':key);
  },[]);
  const assist=useMemo(()=>createReplyAssistController(stage.sessionId,{draft:updateDraft,busy:setAssistBusy,error:reportAssist}),[stage.sessionId,updateDraft,reportAssist]);
  useEffect(()=>{
    const off=workspace.subscribeReplyAssist(assist.accept);
    const connection=workspace.subscribeConnection(value=>{if(!value.connected)assist.interrupt(true);});
    return()=>{off();connection();assist.interrupt(false);};
  },[workspace,assist]);
  const command=useCallback<StageCommand>(async(method,input)=>{
    if(localeSaving&&(method==='narrative.send'||method==='narrative.regenerate'))throw Error('settings:savingLanguage');
    if(assist.isActive() && ['composer.setDraft','narrative.send','narrative.regenerate'].includes(method))throw Error('REPLY_ASSIST_ALREADY_ACTIVE');
    if(method==='composer.setDraft'){updateDraft((input as {text:string}).text);setExpanded(true);return undefined as never;}
    return workspace.command(method,input);
  },[workspace,updateDraft,localeSaving,assist]);
  const render=useMemo(()=>view.world&&view.config?{
    modules:view.world.modules,main:view.world.main,rules:view.world.rules,state:view.world.state,assetBaseUrl:view.world.assetBaseUrl,debug:view.config.debug,
  }:null,[view.world,view.config]);
  const stageKey=view.world?worldReleaseIdentity(view.world.world):undefined;
  const activeRun=stage.activeRunId,active=stage.runs.find(run=>run.runId===activeRun);
  const busy=!!activeRun||view.sending||localeSaving||assistBusy;
  const latestRun=stage.runs.at(-1),latestUser=latestRun?.messages.find(message=>message.role==='user');
  const latestReply=latestRun?.messages.at(-1);
  const canRegenerate=!!latestUser&&!!session&&!busy&&stage.connected&&!stage.history.loading&&!stage.history.error;
  const commandFailure=(reason:unknown,fallback:string)=>{
    if(errorKey(reason)==='REPLY_ASSIST_ALREADY_ACTIVE'){
      workspace.clearNotice();
      reportAssist(reason);
    }else setNotice(errorKey(reason,fallback));
  };
  const regenerate=async()=>{
    if(!canRegenerate||!latestUser)return;
    setNotice('');
    try{await command('narrative.regenerate',{userEntryId:latestUser.id,assistantEntryId:latestReply?.role==='assistant'?latestReply.id:null});}
    catch(reason){commandFailure(reason,'sessions:regenerateFailed');}
  };
  const label=assistBusy&&!activeRun?i18n.t("sessions:assistGenerating"):!stage.connected?i18n.t("sessions:connecting"):activeRun?(active?.phase==='summarizing'?i18n.t("sessions:summarizing"):active?.phase==='preparing'?i18n.t("sessions:preparing"):view.stopping?i18n.t("sessions:stopping"):i18n.t("sessions:generating")):i18n.t("sessions:connected");
  const submit=async(value?:string)=>{
    if(assist.isActive()||busy||view.loading||!stage.connected||!session)return;
    const text=trimTrailingEmptyRoleplayLines(value??draftRef.current);if(!text.trim())return;
    const currentRevision=revision.current;setNotice('');
    try{await command('narrative.send',{text});if(revision.current===currentRevision)updateDraft('');}
    catch(reason){commandFailure(reason,'sessions:sendFailed');}
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
        render&&view.config?<StageHost key={stageKey} config={view.config} render={render} snapshot={stage} command={command} subscribeEvents={workspace.subscribeEvents} fontSize={fontSize} bottomInset={layout.bottomInset} onNotice={setNotice} onComposerButtons={setButtons}/>:
        <p className="loading-panel" role="status">{i18n.t("sessions:preparingStage")}</p>}
      {spriteToggle&&view.world&&render&&!view.error&&!view.worldError&&<CharacterSpriteOverlay key={stageKey} display={view.sprites} characters={view.world.world.characters}
        assetBaseUrl={render.assetBaseUrl} bottomInset={layout.bottomInset}/>}
    </div>
    <div ref={layout.overlay} className={styles.composerArea} data-composer-overlay>
      {error&&<div className={styles.previewError} role="alert">{error}<button type="button" aria-label={i18n.t("sessions:closeNotice")} onClick={()=>{setNotice('');workspace.clearNotice();}}>×</button></div>}
      {expanded&&<ComposerActionRow buttons={buttons} toggle={spriteToggle}/>}
      {expanded?<form className={styles.composer} aria-label={i18n.t("sessions:messageInput")} onSubmit={event=>{event.preventDefault();void submit();}}>
        <button type="button" className={styles.collapse} aria-label={i18n.t("sessions:collapseComposer")} onClick={()=>setExpanded(false)}><ChevronDown size={19}/></button>
        <ComposerMoreMenu canAssist={!!session&&stage.connected&&!stage.history.loading&&!stage.history.error&&!view.loading&&(!view.sending||!!activeRun)&&!assistBusy&&!localeSaving}
          onAssist={()=>{setNotice('');setAssistError('');void assist.start(draftRef.current);}} canRegenerate={canRegenerate} onRegenerate={()=>void regenerate()}/>
        <div ref={layout.composer} className={styles.editor}><RoleplayComposer value={draft} disabled={assistBusy} onChange={updateDraft} onSubmit={text=>void submit(text)}/></div>
        {activeRun||assistBusy?<button className={styles.send} type="button" aria-label={i18n.t("sessions:stopGeneration")} disabled={view.stopping} onClick={()=>void (activeRun?stop():assist.stop())}><Square size={16}/></button>:
          <button className={styles.send} type="submit" aria-label={i18n.t("sessions:sendMessage")} disabled={view.loading||!session||!stage.connected||view.sending||!draft.trim()||draft.length>100000}><Send size={18}/></button>}
      </form>:<div className={styles.collapsedActions}>
        {spriteToggle&&<SpriteToggle {...spriteToggle}/>}
        <button ref={expandButton} className={styles.expand} aria-label={i18n.t("sessions:expandComposer")} onClick={()=>{setExpanded(true);requestAnimationFrame(()=>layout.composer.current?.querySelector<HTMLElement>('.sr-composer-editor')?.focus());}}><ChevronUp size={19}/></button>
        {(activeRun||assistBusy)&&<button className={styles.stopCollapsed} aria-label={i18n.t("sessions:stopGeneration")} disabled={view.stopping} onClick={()=>void (activeRun?stop():assist.stop())}><Square size={16}/></button>}
      </div>}
    </div>
    {assistError&&<Modal title={i18n.t("sessions:assist")} onClose={()=>setAssistError('')}>
      <p>{errorMessage(assistError)}</p>
      {assistError==='REPLY_ASSIST_NOT_CONFIGURED'&&<Link to="/settings">{i18n.t("common:settings")}</Link>}
      {assistError==='REPLY_ASSIST_MODEL_NOT_CONFIGURED'&&<Link to={assistPresetId?'/presets/'+encodeURIComponent(assistPresetId):'/presets'}>{i18n.t("common:presets")}</Link>}
    </Modal>}
    {settingsOpen&&session&&<SessionConfiguration session={session} disabled={busy} onFontSize={setPreviewFont} onClose={()=>{setSettingsOpen(false);setPreviewFont(null);}} onSaved={workspace.updateSession}/>}
  </section>;
}
