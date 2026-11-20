import {api} from '../../api.ts';
import type {HttpRequest} from '../../transport/http.ts';
import {createSessionEventChannel} from '../../transport/session-events.ts';
import {createNarrativeController} from '../narrative/index.ts';
import {createHistoryController,projectRun} from '../history/index.ts';
import {createSuggestionsController} from '../suggestions/index.ts';
import {createStateController} from '../state/index.ts';
import {loadStageWorld} from '../worlds/stage-world.ts';
import {readSession,readRuntimeConfig,type RuntimeConfig} from './client.ts';
import type {Session} from './types.ts';
import type {StageSnapshot,StageRun,StageCommandMap,SessionEvent,NarrativeEvent,Usage,RunPage} from '../../../../../packages/sr-sdk/src/stage-contract.ts';

export type WorkspaceSnapshot={
  session:Session|null;config:RuntimeConfig|null;world:Awaited<ReturnType<typeof loadStageWorld>>|null;
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
  let tip:string|null=null,tipRevision=0,connected=false,usageRevision=0;
  let state:ReturnType<typeof createStateController>|null=null;
  const subscriptions:Array<()=>void>=[];
  const channel=dependencies.channel??createSessionEventChannel({sessionId});
  const history=createHistoryController({sessionId,request});
  const suggestions=createSuggestionsController(sessionId);
  let snapshot:WorkspaceSnapshot;
  const updateTip=(value:string|null)=>{tip=value;tipRevision++;if(session)session={...session,tipEntryId:value};};
  let sessionRequest:Promise<Session>|null=null;
  const refreshSession=():Promise<Session>=>{
    if(sessionRequest)return sessionRequest;
    const revision=tipRevision;
    sessionRequest=getSessionRecord(sessionId,abort.signal).then(value=>{
      if(disposed)throw Error('会话页面已关闭');
      if(revision===tipRevision)tip=value.tipEntryId;
      session={...value,tipEntryId:tip};publish();return session;
    }).finally(()=>{sessionRequest=null;});
    return sessionRequest;
  };
  const narrative=createNarrativeController({sessionId,request,getSession:refreshSession,
    onTipChanged:updateTip,
    onRunSaved:run=>{if(!disposed)history.ingestRun(run);},
    onRunAccepted:()=>{if(!disposed)publish();},
    onTerminal:()=>{if(disposed)return;usageRevision++;void state?.read().catch(()=>{});publish();},
  });
  function project():WorkspaceSnapshot{
    const hs=history.getSnapshot(),ns=narrative.getSnapshot(),ss=state?.getSnapshot();
    const runs:StageRun[]=hs.runs.map(projectRun);
    if(ns.run){
      const index=runs.findIndex(run=>run.runId===ns.run!.runId);
      if(index<0)runs.push(ns.run);
      else{
        const saved=runs[index]!,persistedIds=new Set(saved.messages.map(message=>message.id));
        const extra=ns.run.messages.filter(message=>!persistedIds.has(message.id));
        const settled=['completed','stopped'].includes(saved.status);
        runs[index]={...(!settled?ns.run:saved),messages:[...saved.messages,...extra]};
      }
    }
    return {session,config,world,loading,error,worldError,notice:notice??ns.error,sending:ns.sending,stopping:ns.stopping,usageRevision,latestUsage:ns.usage,
      stage:{sessionId,connected,activeRunId:ns.activeRunId,runs,streamIncomplete:ns.incomplete,suggestions:suggestions.getSnapshot().suggestions,
        history:{loading:hs.loading,loadingMore:hs.loadingMore,hasMore:hs.hasMore,error:hs.error},state:ss?.values??emptyState(),stateLoading:ss?.loading??true,stateError:ss?.error??null}};
  }
  function publish(){if(disposed)return;snapshot=project();for(const listener of listeners){try{listener();}catch{/* Display observers are isolated. */}}}
  snapshot=project();
  subscriptions.push(history.subscribe(publish),narrative.subscribe(publish),suggestions.subscribe(publish));
  subscriptions.push(channel.subscribe('*',event=>{
    if(disposed)return;
    try{if(event.event.startsWith('run.'))narrative.accept(event as NarrativeEvent);}catch{notice='叙事事件处理失败，请重新同步会话';}
    try{suggestions.accept(event);}catch{notice='行动建议暂时不可用';}
    try{if(event.event==='state.changed')state?.accept(event);}catch{notice='状态同步暂时不可用';}
    publish();
    for(const listener of eventListeners){try{listener(event);}catch{/* A frame listener cannot block business consumers. */}}
  }));
  let synchronization:Promise<void>|null=null,repeat=false;
  function synchronize():Promise<void>{
    if(disposed)return Promise.resolve();
    if(synchronization){repeat=true;return synchronization;}
    synchronization=(async()=>{
      do{
        repeat=false;
        const checkpoint=suggestions.checkpoint(),narrativeCheckpoint=narrative.checkpoint(),knownActiveRunId=narrative.getSnapshot().activeRunId;
        try{
          await refreshSession();
          if(!history.getSnapshot().runs.length)await history.loadRecent();else await history.catchUp();
          if(disposed)return;
          const current=history.getSnapshot();
          const page:RunPage={items:current.runs,activeRunId:current.activeRunId,hasMore:current.hasMore,nextCursor:current.nextCursor,nextAfterSeq:current.afterSeq};
          await narrative.recover({page,knownActiveRunId,checkpoint:narrativeCheckpoint});
          if(disposed)return;
          const latest=history.getSnapshot().runs.at(-1)??null;
          suggestions.restore(latest,checkpoint);
          // Catch-up can discover a newer persisted tip without a terminal event on this connection.
          await refreshSession();
          await state?.read();
          notice=null;
        }catch(reason){if(!disposed)notice=reason instanceof Error?reason.message:'会话同步失败';}
        publish();
      }while(repeat&&!disposed);
    })().finally(()=>{synchronization=null;});
    return synchronization;
  }
  subscriptions.push(channel.subscribeConnection(value=>{
    if(disposed)return;connected=value.connected;narrative.setConnected(connected);publish();
    if(connected&&started){usageRevision++;void synchronize();}
  }));
  async function loadWorld(){
    if(!session||disposed)return;worldError=null;publish();
    try{world=await getWorld(session.worldId,abort.signal);}catch(reason){if(!disposed)worldError=reason instanceof Error?reason.message:'世界组件加载失败';}
    publish();
  }
  async function start(){
    if(started||disposed)return;started=true;channel.connect();
    try{
      const [current,settings]=await Promise.all([refreshSession(),getRuntimeConfig(abort.signal)]);
      if(disposed)return;config=settings;
      state=createStateController({sessionId,worldId:current.worldId,getTipEntryId:()=>tip,request});
      subscriptions.push(state.subscribe(publish));
      await Promise.allSettled([loadWorld(),synchronize()]);
      if(!disposed){loading=false;publish();}
    }catch(reason){if(!disposed){loading=false;error=reason instanceof Error?reason.message:'会话加载失败';publish();}}
  }
  async function command<K extends keyof StageCommandMap>(method:K,input:StageCommandMap[K]['input']):Promise<StageCommandMap[K]['output']>{
    if(disposed)throw Error('会话页面已关闭');
    let result:unknown;
    switch(method){
      case 'narrative.send':
        try{result=await narrative.send((input as {text:string}).text);}
        catch(reason){await synchronize();throw reason;}
        break;
      case 'narrative.stop':result=await narrative.stop((input as {runId:string}).runId);break;
      case 'history.loadMore':await history.loadOlder();break;
      case 'history.refresh':await synchronize();break;
      case 'history.query':result=await history.query(input as StageCommandMap['history.query']['input']);break;
      case 'state.read':if(!state)throw Error('会话状态尚未就绪');result=await state.read();break;
      case 'state.write':if(!state)throw Error('会话状态尚未就绪');result=await state.write((input as StageCommandMap['state.write']['input']).updates);break;
      case 'composer.setDraft':throw Error('此命令需要会话输入框');
    }
    publish();return result as StageCommandMap[K]['output'];
  }
  return {
    start,command,refresh:synchronize,reloadWorld:loadWorld,
    getSnapshot:()=>snapshot,
    subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
    subscribeEvents:(listener:(event:SessionEvent)=>void)=>{eventListeners.add(listener);return()=>{eventListeners.delete(listener);};},
    updateSession(value:Session){if(disposed||value.id!==sessionId)return;session={...value,tipEntryId:tip};publish();},
    clearNotice(){notice=null;narrative.clearError();publish();},
    dispose(){if(disposed)return;disposed=true;abort.abort();channel.dispose();narrative.dispose();history.dispose();suggestions.dispose();state?.dispose();for(const unsubscribe of subscriptions)unsubscribe();listeners.clear();eventListeners.clear();},
  };
}
export type SessionWorkspace=ReturnType<typeof createSessionWorkspace>;
