import {errorKey} from '../../i18n/errors.ts';
import {api} from '../../api.ts';
import type {HttpRequest} from '../../transport/http.ts';
import {createSessionEventChannel,isReplyAssist,type ReplyAssistEvent} from '../../transport/session-events.ts';
import {createNarrativeController} from '../narrative/index.ts';
import {createHistoryController,projectRun} from '../history/index.ts';
import {createSuggestionsController} from '../suggestions/index.ts';
import {createStateController} from '../state/index.ts';
import {createSpriteController,type SpriteDisplay} from '../character-sprites/controller.ts';
import {loadStageWorld} from '../worlds/stage-world.ts';
import {readSession,readRuntimeConfig,type RuntimeConfig,type SessionCapabilities} from './client.ts';
import type {Session} from './types.ts';
import type {StageSnapshot,StageRun,StageCommandMap,SessionEvent,NarrativeEvent,Usage} from '../../../../../packages/sr-sdk/src/stage-contract.ts';

export type WorkspaceSnapshot={
  session:Session|null;config:RuntimeConfig|null;world:Awaited<ReturnType<typeof loadStageWorld>>|null;
  capabilities:SessionCapabilities|null;
  sprites:SpriteDisplay;
  loading:boolean;error:string|null;worldError:string|null;notice:string|null;
  stage:StageSnapshot;sending:boolean;stopping:boolean;usageRevision:number;latestUsage:Usage|null|undefined;
};
const emptyState=()=>({global:{},session:{},message:{}});
/** Explicit session composition. Controllers own data; this module only binds their lifetimes and projections. */
export type WorkspaceDependencies={
  request?:HttpRequest;readSession?:typeof readSession;readRuntimeConfig?:typeof readRuntimeConfig;
  loadStageWorld?:typeof loadStageWorld;channel?:ReturnType<typeof createSessionEventChannel>;
};
export function createSessionWorkspace(sessionId:string,dependencies:WorkspaceDependencies={}){
  const request=dependencies.request??api,getSessionRecord=dependencies.readSession??readSession,
    getRuntimeConfig=dependencies.readRuntimeConfig??readRuntimeConfig,getWorld=dependencies.loadStageWorld??loadStageWorld;
  const abort=new AbortController(),listeners=new Set<()=>void>(),eventListeners=new Set<(event:SessionEvent)=>void>();
  let disposed=false,started=false,loading=true,error:string|null=null,worldError:string|null=null,notice:string|null=null;
  let session:Session|null=null,config:RuntimeConfig|null=null,world:WorkspaceSnapshot['world']=null;
  let capabilities:SessionCapabilities|null=null,configRevision=0,savedSettingsRevision=0;
  let tip:string|null=null,tipRevision=0,connected=false,usageRevision=0;
  let state:ReturnType<typeof createStateController>|null=null;
  const subscriptions:Array<()=>void>=[];
  const channel=dependencies.channel??createSessionEventChannel({sessionId});
  const history=createHistoryController({sessionId,request});
  const sprites=createSpriteController({sessionId,request,history,changed:publish,
    readTip:async signal=>(await getSessionRecord(sessionId,signal)).tipEntryId});
  const suggestions=createSuggestionsController(sessionId);
  const appliedDeletions=new Set<string>();
  let snapshot:WorkspaceSnapshot;
  function bindSprites(){
    return sprites.bind(capabilities?.characterSprite.available ? session?.worldId??null : null);
  }
  async function refreshRuntimeConfig(){
    const revision=++configRevision;
    try{
      const settings=await getRuntimeConfig(sessionId,abort.signal);
      if(disposed||revision!==configRevision)return;
      // StageHost binds its iframe lifetime to the deployment configuration object.
      if(!config||config.debug!==settings.debug||config.stage.origin!==settings.stage.origin||config.stage.entryPath!==settings.stage.entryPath){
        config={stage:settings.stage,debug:settings.debug};
      }
      capabilities=settings.capabilities;
      const bindingChanged=bindSprites();
      if(bindingChanged&&!loading&&capabilities?.characterSprite.available)restoreSpriteFrame();
      publish();
    }catch(reason){
      if(disposed||revision!==configRevision)return;
      capabilities=null;
      bindSprites();
      publish();
      throw reason;
    }
  }
  function reloadCapabilities(){
    void refreshRuntimeConfig().catch(reason=>{notice=errorKey(reason,"sessions:syncFailed");publish();});
  }
  const updateTip=(value:string|null)=>{tip=value;tipRevision++;if(session)session={...session,tipEntryId:value};};
  let sessionRequest:Promise<Session>|null=null;
  const refreshSession=():Promise<Session>=>{
    if(sessionRequest)return sessionRequest;
    const revision=tipRevision,settingsRevision=savedSettingsRevision;
    sessionRequest=getSessionRecord(sessionId,abort.signal).then(value=>{
      if(disposed)throw Error("sessions:closed");
      if(revision===tipRevision)tip=value.tipEntryId;
      const current=settingsRevision!==savedSettingsRevision&&session?session:value;
      if(config&&session&&session.runtimeConfig.narrativePresetId!==current.runtimeConfig.narrativePresetId){capabilities=null;reloadCapabilities();}
      session={...current,tipEntryId:tip};bindSprites();publish();return session;
    }).finally(()=>{sessionRequest=null;});
    return sessionRequest;
  };
  const narrative=createNarrativeController({sessionId,request,getSession:refreshSession,
    onTipChanged:updateTip,
    onAccepted:accepted=>{for(const id of accepted.deletedMessageIds)appliedDeletions.add(id);history.acceptExecution(accepted);sprites.remove(accepted.deletedMessageIds,accepted.tipEntryId);suggestions.begin(accepted.runId,accepted.assistantEntryId);if(accepted.deletedMessageIds.length){usageRevision++;void state?.read().catch(()=>{});}},
    onTerminal:event=>{
      if(disposed)return;
      const id=event.data.assistantEntryId;
      if(tip===id&&sprites.getSnapshot().frame?.messageId!==id&&event.data.savedMessageIds.includes(id)){
        void sprites.restore(tip,sprites.checkpoint(),id);
      }
      usageRevision++;void synchronize();
    },
  });
  function restoreSpriteFrame(){
    const checkpoint=sprites.checkpoint();
    void refreshSession().then(current=>sprites.restore(current.tipEntryId,checkpoint))
      .catch(reason=>{if(!disposed){notice=errorKey(reason,"sessions:syncFailed");publish();}});
  }
  let historySource: ReturnType<typeof history.getSnapshot>['runs'] | undefined;
  let savedRuns: StageRun[] = [];
  function project():WorkspaceSnapshot{
    const hs=history.getSnapshot(),ns=narrative.getSnapshot(),ss=state?.getSnapshot();
    if(historySource!==hs.runs){ historySource=hs.runs; savedRuns=hs.runs.map(projectRun); }
    const runs=ns.run?[...savedRuns]:savedRuns;
    if(ns.run){
      const index=runs.findIndex(run=>run.runId===ns.run!.runId);
      if(index<0)runs.push(ns.run);
      else{
        const saved=runs[index]!,persistedIds=new Set(saved.messages.map(message=>message.id));
        const extra=ns.run.messages.filter(message=>!persistedIds.has(message.id));
        const settled=['completed','stopped'].includes(saved.status)&&saved.assistantEntryId===ns.run.assistantEntryId;
        runs[index]=settled?saved:{...ns.run,messages:[...saved.messages,...extra]};
      }
    }
    return {session,config,capabilities,sprites:sprites.getSnapshot(),world,loading,error,worldError,notice:notice??ns.error,sending:ns.sending,stopping:ns.stopping,usageRevision,latestUsage:ns.usage,
      stage:{sessionId,connected,activeRunId:ns.activeRunId,activeAssistantEntryId:ns.activeRunId?ns.run?.assistantEntryId??null:null,sending:ns.sending,runs,streamIncomplete:ns.incomplete,suggestions:suggestions.getSnapshot().suggestions,
        history:{loading:hs.loading,loadingMore:hs.loadingMore,hasMore:hs.hasMore,error:hs.error},state:ss?.values??emptyState(),stateLoading:ss?.loading??true,stateError:ss?.error??null}};
  }
  function publish(){if(disposed)return;snapshot=project();for(const listener of listeners){try{listener();}catch{/* Display observers are isolated. */}}}
  snapshot=project();
  subscriptions.push(history.subscribe(publish),narrative.subscribe(publish),suggestions.subscribe(publish));
  subscriptions.push(channel.subscribe('*',event=>{
    if(disposed||isReplyAssist(event))return;
    try{
      if(event.event.startsWith('run.') && narrative.accept(event as NarrativeEvent)===false)return;
      if(event.event==='character_sprite.changed')sprites.accept(event.data);
      if(event.event==='run.created')sprites.remove(event.data.deletedMessageIds,event.data.tipEntryId);
      if(event.event==='message.deleted'){
        if(appliedDeletions.has(event.data.messageId))return;
        appliedDeletions.add(event.data.messageId);
        narrative.acceptDeletion(event.data);
        history.acceptExecution({...event.data,deletedMessageIds:[event.data.messageId]});
        sprites.remove([event.data.messageId],event.data.tipEntryId);
        updateTip(event.data.tipEntryId);suggestions.clear();usageRevision++;
      }
    }catch{notice="sessions:narrativeEventFailed";}
    try{suggestions.accept(event);}catch{notice="sessions:suggestionsUnavailable";}
    try{if(event.event==='state.changed')state?.accept(event);}catch{notice="sessions:stateSyncUnavailable";}
    publish();
    for(const listener of eventListeners){try{listener(event);}catch{/* A frame listener cannot block business consumers. */}}
  }));
  let synchronization:Promise<void>|null=null,repeat=false,resetHistory=false;
  function synchronize(reset = false):Promise<void>{
    if(reset)sprites.resetHistory();
    resetHistory ||= reset;
    if(disposed)return Promise.resolve();
    if(synchronization){repeat=true;return synchronization;}
    synchronization=(async()=>{
      do{
        repeat=false;
        const checkpoint=suggestions.checkpoint(),narrativeCheckpoint=narrative.checkpoint(),spriteCheckpoint=sprites.checkpoint();
        try{
          await refreshSession();
          const reset=resetHistory;resetHistory=false;
          if(reset||!history.getSnapshot().runs.length)await history.loadRecent(reset);else await history.catchUp();
          if(disposed)return;
          const current=history.getSnapshot();
          const latest=current.runs.at(-1)??null;
          const active=current.activeRunId && current.runs.find(run=>run.runId===current.activeRunId);
          narrative.reconcile(active||latest||undefined,narrativeCheckpoint);
          suggestions.restore(latest,checkpoint);
          // Catch-up can discover a newer persisted tip without a terminal event on this connection.
          await refreshSession();
          void sprites.restore(tip,spriteCheckpoint);
          await state?.read();
          notice=null;
        }catch(reason){if(!disposed)notice=errorKey(reason,"sessions:syncFailed");}
        publish();
      }while(repeat&&!disposed);
    })().finally(()=>{synchronization=null;});
    return synchronization;
  }
  subscriptions.push(channel.subscribeConnection(value=>{
    if(disposed)return;connected=value.connected;narrative.setConnected(connected);publish();
    if(connected&&started){usageRevision++;if(config)reloadCapabilities();void synchronize(true);}
  }));
  async function loadWorld(){
    if(!session||disposed)return;worldError=null;publish();
    try{world=await getWorld(session.worldId,abort.signal);}catch(reason){if(!disposed)worldError=errorKey(reason,"sessions:worldLoadFailed");}
    publish();
  }
  async function start(){
    if(started||disposed)return;started=true;channel.connect();
    try{
      const [current]=await Promise.all([refreshSession(),refreshRuntimeConfig()]);
      if(disposed)return;
      state=createStateController({sessionId,worldId:current.worldId,getTipEntryId:()=>tip,request});
      subscriptions.push(state.subscribe(publish));
      await Promise.allSettled([loadWorld(),synchronize()]);
      if(!disposed){loading=false;publish();}
    }catch(reason){if(!disposed){loading=false;error=errorKey(reason,"sessions:loadFailed");publish();}}
  }
  async function command<K extends keyof StageCommandMap>(method:K,input:StageCommandMap[K]['input']):Promise<StageCommandMap[K]['output']>{
    if(disposed)throw Error("sessions:closed");
    let result:unknown;
    switch(method){
      case 'narrative.send':
        try{result=await narrative.send((input as {text:string}).text);}
        catch(reason){await synchronize();throw reason;}
        break;
      case 'narrative.regenerate':
        if(!connected)throw Error("sessions:regenerateOffline");
        try{result=await narrative.regenerate(input as StageCommandMap['narrative.regenerate']['input']);}
        catch(reason){await synchronize(true);throw reason;}
        break;
      case 'narrative.stop':{const value=input as StageCommandMap['narrative.stop']['input'];result=await narrative.stop(value.runId,value.assistantEntryId);break;}
      case 'history.loadMore':await history.loadOlder();break;
      case 'history.refresh':await refresh();break;
      case 'history.query':result=await history.query(input as StageCommandMap['history.query']['input']);break;
      case 'state.read':if(!state)throw Error("sessions:notReady");result=await state.read();break;
      case 'state.write':if(!state)throw Error("sessions:notReady");result=await state.write((input as StageCommandMap['state.write']['input']).updates);break;
      case 'composer.setDraft':throw Error("sessions:composerRequired");
    }
    publish();return result as StageCommandMap[K]['output'];
  }
  async function refresh(){await Promise.all([synchronize(true),refreshRuntimeConfig()]);}
  return {
    setSpritesEnabled(enabled:boolean){
      sprites.setEnabled(enabled);
      if(enabled)restoreSpriteFrame();
    },
    subscribeReplyAssist:(listener:(event:ReplyAssistEvent)=>void)=>channel.subscribe('reply_assist',event=>{if(isReplyAssist(event))listener(event);}),
    subscribeConnection:channel.subscribeConnection,
    start,command,refresh,reloadWorld:loadWorld,
    getSnapshot:()=>snapshot,
    subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
    subscribeEvents:(listener:(event:SessionEvent)=>void)=>{eventListeners.add(listener);return()=>{eventListeners.delete(listener);};},
    updateSession(value:Session){
      if(disposed||value.id!==sessionId)return;
      savedSettingsRevision++;
      if(session?.runtimeConfig.narrativePresetId!==value.runtimeConfig.narrativePresetId){capabilities=null;bindSprites();reloadCapabilities();}
      if(session&&session.runtimeConfig.apiModelConfigId!==value.runtimeConfig.apiModelConfigId)usageRevision++;
      session={...value,tipEntryId:tip};publish();
    },
    clearNotice(){notice=null;narrative.clearError();publish();},
    dispose(){if(disposed)return;disposed=true;abort.abort();channel.dispose();sprites.dispose();narrative.dispose();history.dispose();suggestions.dispose();state?.dispose();for(const unsubscribe of subscriptions)unsubscribe();listeners.clear();eventListeners.clear();},
  };
}
export type SessionWorkspace=ReturnType<typeof createSessionWorkspace>;
