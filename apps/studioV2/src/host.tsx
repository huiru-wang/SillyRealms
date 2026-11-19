import {readAppearance} from './styles/theme';
import {isPostprocessError} from '../../../packages/sr-sdk/src/postprocess-feedback';
import {ActionSuggestionStore} from './features/sessions/action-suggestions';
import {stateManifest} from './features/sessions/state-manifest';
import React,{useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {ArrowLeft,ChevronDown,ChevronUp,Send,Square,Settings2} from 'lucide-react';
import {Link} from 'react-router-dom';
import styles from './features/sessions/Sessions.module.css';
import {api,json,ApiError} from './api';
import {randomId} from './random-id';
import {stageURL} from './stage-url';
import {RoleplayComposer} from './features/sessions/composer/RoleplayComposer';
import {SessionTokenUsage} from './features/sessions/SessionTokenUsage';
import {SessionSettingsDialog,type CapabilityView} from './features/sessions/SessionSettingsDialog';
import {compileWorldComponents} from './features/worlds/compile-world-components';
import {compileComponents} from '@sillyrealms/ui-compiler';
import {worldAssetBaseUrl} from './world-assets';
import {MessageMatcher} from './message-matcher';
import {trimTrailingEmptyRoleplayLines} from '@sillyrealms/roleplay';
import type {MessageRule} from '../../../packages/sr-sdk/src/story-context';

/** Trusted bridge: it forwards commands and events without holding state or history snapshots. */
export function SessionHost({id}:{id:string}) {
  const [notice,setNotice]=useState('');
  const debugRef=useRef(false);
  const [title,setTitle]=useState('');
  const [preset,setPreset]=useState<string|null>(null);
  const [modelConfig,setModelConfig]=useState<string|null>(null);
  const [presets,setPresets]=useState<Array<{id:string;name:string}>>([]);
  const [modelConfigs,setModelConfigs]=useState<Array<{id:string;name:string;modelId:string}>>([]);
  const [settingsOpen,setSettingsOpen]=useState(false);
  const [settingsTitle,setSettingsTitle]=useState('');
  const [settingsPreset,setSettingsPreset]=useState('');
  const [settingsModel,setSettingsModel]=useState('');
  const [capabilities,setCapabilities]=useState<CapabilityView|null>(null);
  const [capabilitiesLoading,setCapabilitiesLoading]=useState(false);
  const [phase,setPhase]=useState('preparing');
  const phaseRef=useRef('preparing');
  const [settingsSaving,setSettingsSaving]=useState(false);
  const [settingsError,setSettingsError]=useState('');
  const [usageRevision,setUsageRevision]=useState(0);
  const [fontSize,setFontSize]=useState(16);
  const fontSizeRef=useRef(16);fontSizeRef.current=fontSize;
  const [settingsFontSize,setSettingsFontSize]=useState(16);
  const fontSizeBeforeSettings=useRef(16);
  const fontPreferenceKey='sr:session:'+id+':reading-font-size';
  const [loaded,setLoaded]=useState(false);
  const [fatal,setFatal]=useState(false);
  const [fatalMessage,setFatalMessage]=useState('');
  const [online,setOnline]=useState(false);
  const [mounted,setMounted]=useState(false);
  const [draft,setDraft]=useState('');
  const draftRef=useRef('');draftRef.current=draft;
  const draftRevision=useRef(0);
  const [expanded,setExpanded]=useState(true);
  const [sending,setSending]=useState(false);
  const [activeRun,setActiveRun]=useState<string|null>(null);
  const [stopping,setStopping]=useState(false);
  const frame=useRef<HTMLIFrameElement>(null);
  const expandButton=useRef<HTMLButtonElement>(null);
  const port=useRef<MessagePort|null>(null);
  const ready=useRef(false),connected=useRef(false),mountedRef=useRef(false),fatalRef=useRef(false),activeRef=useRef<string|null>(null),sendingRef=useRef(false);
  const renderRef=useRef<{worldId?:string;modules:{code:Record<string,string>;errors:Record<string,string>};main?:string;rules:unknown[];state:unknown}>({modules:{code:{},errors:{}},rules:[],state:{}}),loadedRef=useRef(false);
  const renderPayload=useCallback((origin:string)=>{const {worldId,...render}=renderRef.current;return {type:'render',...render,debug:debugRef.current,assetBaseUrl:worldAssetBaseUrl(origin,worldId)};},[]);
  const suggestions=useMemo(()=>new ActionSuggestionStore(id,event=>port.current?.postMessage({type:'event',event})),[id]);
  const terminal=useRef(new Set<string>());
  const nonce=useMemo(()=>randomId(),[id]);
  const [stageAttempt,setStageAttempt]=useState(0),[stageError,setStageError]=useState('');
  const [stageSource,setStageSource]=useState<{url:string;origin:string;nonce:string}|null>(null);
  const stageSourceRef=useRef(stageSource);stageSourceRef.current=stageSource;
  const stageTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const resetStageConnection=useCallback(()=>{
    clearTimeout(stageTimer.current);port.current?.close();port.current=null;
    ready.current=false;mountedRef.current=false;setMounted(false);
  },[]);
  const failStage=useCallback((message:string)=>{resetStageConnection();setStageError(message);},[resetStageConnection]);
  const onStageLoad=useCallback(()=>{
    if(!stageSource)return;
    resetStageConnection();
    stageTimer.current=setTimeout(()=>failStage('故事舞台连接超时，请确认服务可用后重试。'),10000);
    frame.current?.contentWindow?.postMessage({type:'sr-probe',nonce:stageSource.nonce},stageSource.origin);
  },[stageSource,resetStageConnection,failStage]);
  const updateDraft=useCallback((value:string)=>{draftRevision.current++;draftRef.current=value;setDraft(value);},[]);
  const base=`v1/sessions/${encodeURIComponent(id)}`;
  const detail=useRef<HTMLElement>(null);
  const composer=useRef<HTMLDivElement>(null),composerOverlay=useRef<HTMLDivElement>(null),stageViewport=useRef<HTMLDivElement>(null);
  const [bottomInset,setBottomInset]=useState(0);
  const appearanceRef=useRef({fontSize,bottomInset,colors:{} as Record<string,string>});
  const syncAppearance=useCallback(()=>{
    appearanceRef.current={fontSize:fontSizeRef.current,bottomInset:appearanceRef.current.bottomInset,...readAppearance()};
    port.current?.postMessage({type:'appearance',...appearanceRef.current});
  },[]);
  useEffect(()=>{appearanceRef.current.bottomInset=bottomInset;syncAppearance();},[bottomInset,fontSize,syncAppearance]);
  useEffect(()=>{
    const viewport=window.visualViewport;
    const update=()=>{
      const element=detail.current;if(!element)return;
      if(viewport&&window.innerWidth<=760&&viewport.scale===1){
        element.style.setProperty('--session-viewport-height',Math.min(window.innerHeight,viewport.height+viewport.offsetTop)+'px');
      }else element.style.removeProperty('--session-viewport-height');
    };
    update();
    viewport?.addEventListener('resize',update);
    viewport?.addEventListener('scroll',update);
    window.addEventListener('resize',update);
    return()=>{
      viewport?.removeEventListener('resize',update);
      viewport?.removeEventListener('scroll',update);
      window.removeEventListener('resize',update);
    };
  },[]);
  useLayoutEffect(()=>{
    const overlay=composerOverlay.current,viewport=stageViewport.current;
    if(!overlay||!viewport)return;
    let frame:number|undefined;
    const measure=()=>{
      frame=undefined;
      const bounds=viewport.getBoundingClientRect();
      const input=composer.current?.querySelector<HTMLElement>('.sr-composer-editor');
      if(input){
        // Keep the state dialog's close control usable even with a send error
        // and a mobile keyboard. Measure the chrome instead of assuming its height.
        const chrome=overlay.getBoundingClientRect().height-input.getBoundingClientRect().height;
        const room=Math.max(44,Math.floor(bounds.height-96-chrome))+'px';
        if(overlay.style.getPropertyValue('--composer-editor-room')!==room)overlay.style.setProperty('--composer-editor-room',room);
      }
      const inset=Math.max(0,Math.min(800,bounds.height,Math.ceil(bounds.bottom-overlay.getBoundingClientRect().top)));
      setBottomInset(previous=>previous===inset?previous:inset);
    };
    const observer=new ResizeObserver(()=>{if(frame===undefined)frame=requestAnimationFrame(measure);});
    observer.observe(overlay);observer.observe(viewport);measure();
    return()=>{observer.disconnect();if(frame!==undefined)cancelAnimationFrame(frame);};
  },[]);

  useEffect(()=>{if(!expanded)expandButton.current?.focus();},[expanded]);
  useEffect(()=>{
    let stored=16;
    try {const value=Number(localStorage.getItem(fontPreferenceKey));if(Number.isInteger(value)&&value>=13&&value<=21)stored=value;}
    catch {/* Reading preference storage is optional. */}
    setFontSize(stored);setSettingsFontSize(stored);fontSizeBeforeSettings.current=stored;
  },[fontPreferenceKey]);
  useEffect(()=>{port.current?.postMessage({type:'appearance',fontSize});},[fontSize]);
  const stop=useCallback(async(runId:string)=>{
    setStopping(true);
    try {await api(`${base}/runs/${encodeURIComponent(runId)}/stop`,{method:'POST'});}
    catch(error){setNotice(error instanceof Error?error.message:'停止失败');}
    finally {setStopping(false);}
  },[base]);
  const block=useCallback((message?:string)=>{
    setFatalMessage(message||'请检查世界卡组件配置后重试。');
    fatalRef.current=true;mountedRef.current=false;setFatal(true);setMounted(false);setFontSize(fontSizeBeforeSettings.current);setSettingsOpen(false);setNotice('');
    if(activeRef.current)void stop(activeRef.current);
  },[stop]);
  const send=useCallback(async(text:string,isCurrent:()=>boolean=()=>true)=>{
    if(fatalRef.current)throw Error('世界卡数据异常');
    if(!connected.current)throw Error('连接尚未就绪');
    if(!mountedRef.current)throw Error('会话页面尚未就绪');
    if(!text.trim()||text.length>100000)throw Error('请输入有效内容');
    if(sendingRef.current||activeRef.current)throw Error('当前会话正在生成');
    sendingRef.current=true;setSending(true);
    try {
      const current=await api(base);
      if(!isCurrent())throw Error('会话页面已断开');
      if(fatalRef.current)throw Error('世界卡数据异常');
      const result=await api(`${base}/runs`,{method:'POST',body:json({text,requestId:randomId(),expectedTipEntryId:current.tipEntryId})});
      if(fatalRef.current){void stop(result.runId);throw Error('世界卡数据异常');}
      suggestions.accepted(result.runId);
      if(!terminal.current.has(result.runId)){activeRef.current=result.runId;setActiveRun(result.runId);}
      return result;
    } finally {sendingRef.current=false;setSending(false);}
  },[base,stop,suggestions]);

  // Install the trusted handshake before a cached iframe can emit sr-ready.
  useLayoutEffect(()=>{
    ready.current=false;connected.current=false;mountedRef.current=false;fatalRef.current=false;activeRef.current=null;
    draftRevision.current++;setDraft('');setExpanded(true);setFatal(false);setFatalMessage('');setMounted(false);setLoaded(false);setOnline(false);setActiveRun(null);setNotice('');setSettingsOpen(false);setSettingsError('');setPresets([]);setModelConfigs([]);setModelConfig(null);setCapabilities(null);loadedRef.current=false;renderRef.current={modules:{code:{},errors:{}},rules:[],state:{}};terminal.current.clear();suggestions.reset();
    const stream=new EventSource(`/api/${base}/events`);
    const matcher=new MessageMatcher();
    let recoverySequence=0;
    const restoreRun=(result:any)=>{
      if(!result||typeof result.runId!=='string')return;
      const {input:_input,...publicResult}=result;
      if(['completed','failed','stopped'].includes(result.status)){
        terminal.current.add(result.runId);
        suggestions.settled(result.runId,result.status,result.messages??[]);
        if(activeRef.current===result.runId){activeRef.current=null;setActiveRun(null);}
        port.current?.postMessage({type:'event',event:{event:'run.'+result.status,data:{...publicResult,messages:result.messages??[]}}});
      }else if(!terminal.current.has(result.runId)){
        activeRef.current=result.runId;setActiveRun(result.runId);
        phaseRef.current=result.phase??'preparing';setPhase(phaseRef.current);
        port.current?.postMessage({type:'event',event:{event:'run.snapshot',data:{runId:result.runId,
          status:result.status??'preparing',messages:result.messages??[],phase:phaseRef.current,
          extensions:result.extensions}}});
      }
    };
    const recover=async()=>{
      if(!connected.current)return;
      const sequence=++recoverySequence,known=activeRef.current,suggestionVersion=suggestions.version;
      try {
        const current=await api(base);
        if(gone||!connected.current||sequence!==recoverySequence)return;
        const latest=await api(base+'/runs?limit=1');
        if(gone||!connected.current||sequence!==recoverySequence)return;
        suggestions.verifyLatest(current.activeRun?.id??latest.runs?.at(-1)?.id,suggestionVersion);
        port.current?.postMessage({type:'event',event:{event:'session.connection',data:{connected:true}}});
        const runId=current.activeRun?.runId??current.activeRun?.id??known;
        if(runId){
          try {
            const result=await api(base+'/runs/'+encodeURIComponent(runId));
            if(!gone&&sequence===recoverySequence&&suggestionVersion===suggestions.version)restoreRun({...result,runId});
          }catch(error){
            // A preparation task has no durable entry until startRun. After a
            // restart, authoritative absence releases its transient UI state.
            if(error instanceof ApiError&&error.errorCode==='RUN_NOT_FOUND'&&!current.activeRun&&known===runId&&activeRef.current===runId){
              if(!gone&&sequence===recoverySequence){
                restoreRun({runId,status:'failed',phase:'finalized',errorCode:'RUN_INTERRUPTED',errorMessage:'准备阶段已中断，请重新发送。'});
                setNotice('准备阶段已中断，草稿已保留，可以重新发送。');
              }
            }else throw error;
          }
        }
      }catch{if(!gone)setNotice('运行状态恢复失败，请重新连接后重试');}
    };
    stream.onopen=()=>{connected.current=true;void recover();loadStage();loadSettings();setOnline(true);setUsageRevision(value=>value+1);if(ready.current)port.current?.postMessage({type:'connected'});};
    stream.onerror=()=>{recoverySequence++;connected.current=false;setOnline(false);port.current?.postMessage({type:'event',event:{event:'session.connection',data:{connected:false}}});};
    stream.addEventListener('usage.updated',()=>setUsageRevision(value=>value+1));
    for(const name of ['run.created','run.phase','run.delta','run.completed','run.failed','run.stopped','state.changed','action_suggestions.changed'])stream.addEventListener(name,(event:MessageEvent)=>{
      try {
        const data=JSON.parse(event.data);
        if(name==='action_suggestions.changed'){suggestions.receive(data);return;}
        if(name==='run.created'||name==='run.phase')suggestions.accepted(data.runId);
        if(name.startsWith('run.') && typeof data.runId==='string'){
          if(['run.completed','run.failed','run.stopped'].includes(name)){
            suggestions.settled(data.runId,name.slice(4),data.messages??[]);
            terminal.current.add(data.runId);if(terminal.current.size>100){const oldest=terminal.current.values().next().value!;terminal.current.delete(oldest);}
            if(activeRef.current===data.runId){activeRef.current=null;setActiveRun(null);}
            if(name==='run.failed'&&(debugRef.current||!isPostprocessError(data.errorCode)))setNotice(String(data.errorMessage??'未知错误'));
          } else if(!terminal.current.has(data.runId)){activeRef.current=data.runId;setActiveRun(data.runId);if(data.phase){phaseRef.current=data.phase;setPhase(data.phase);}}
        }
        port.current?.postMessage({type:'event',event:{event:name,data}});
      } catch {setNotice('会话事件无效');}
    });
    const listener=(event:MessageEvent)=>{
      const source=stageSourceRef.current;
      if(gone||!source||event.origin!==source.origin||event.source!==frame.current?.contentWindow||event.data?.type!=='sr-ready'||event.data.nonce!==source.nonce||fatalRef.current||port.current)return;
      ready.current=false;mountedRef.current=false;setMounted(false);
      const channel=new MessageChannel();port.current=channel.port1;
      channel.port1.onmessage=async message=>{
        if(gone||port.current!==channel.port1)return;
        const payload=message.data;
        if(payload.type==='ready-ack'){
          clearTimeout(stageTimer.current);setStageError('');
          ready.current=true;if(loadedRef.current)channel.port1.postMessage(renderPayload(source.origin));
          channel.port1.postMessage({type:'theme',value:document.documentElement.dataset.theme??'light'});
          syncAppearance();
          if(connected.current)channel.port1.postMessage({type:'connected'});
        } else if(payload.type==='page-mounted'){if(!fatalRef.current){mountedRef.current=true;setMounted(true);suggestions.publish();void recover();}}
        else if(payload.type==='set-draft'){
          if(!fatalRef.current && typeof payload.text==='string' && payload.text.length<=100000){updateDraft(payload.text);setExpanded(true);}
        } else if(payload.type==='sdk-error')setNotice('SDK 错误：'+payload.message);
        else if(payload.type==='message-error')setNotice('消息组件 '+String(payload.component??'')+' 加载失败：'+String(payload.message??'请检查组件配置')+'，将显示原文');
        else if(payload.type==='ui-error')block(String(payload.message??'世界卡组件运行失败'));
        else if(payload.type==='request'){
          try {
            if(new TextEncoder().encode(JSON.stringify(payload)).byteLength>2*1024*1024)throw Error('消息过大');
            if(fatalRef.current && ['state.write','session.send'].includes(payload.method))throw Error('世界卡数据异常');
            let result:unknown;
            if(payload.method==='state.read')result=await api(`${base}/state`);
            else if(payload.method==='state.write')result=await api(`${base}/state`,{method:'PATCH',body:json(payload.data)});
            else if(payload.method==='session.history'){
              const query=new URLSearchParams();if(payload.data?.cursor)query.set('cursor',payload.data.cursor);if(payload.data?.limit!==undefined)query.set('limit',String(payload.data.limit));
              result=await api(`${base}/runs?${query}`);
            } else if(payload.method==='session.send')result=await send(payload.data?.text,()=>!gone&&port.current===channel.port1);
            else if(payload.method==='message.match'){
              if(typeof payload.data?.text!=='string'||!['user','assistant'].includes(payload.data?.role))throw Error('消息无效');
              result=await matcher.match(payload.data.text,payload.data.role,renderRef.current.rules as MessageRule[]);
            }
            else throw Error('不支持的命令');
            if(!gone&&port.current===channel.port1)channel.port1.postMessage({type:'response',id:payload.id,data:result});
          } catch(error){if(!gone&&port.current===channel.port1)channel.port1.postMessage({type:'response',id:payload.id,error:error instanceof Error?error.message:String(error)});}
        }
      };
      frame.current?.contentWindow?.postMessage({type:'sr-connect',nonce:source.nonce},source.origin,[channel.port2]);
    };
    window.addEventListener('message',listener);
    const themeObserver=new MutationObserver(()=>{port.current?.postMessage({type:'theme',value:document.documentElement.dataset.theme??'light'});syncAppearance();});
    themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','data-theme-id','style']});
    let gone=false;
    const loadSettings=()=>{
    void (async()=>{
      const items:Array<{id:string;name:string}>=[];let cursor:string|null=null;
      do {
        const query=new URLSearchParams({limit:'100'});if(cursor)query.set('cursor',cursor);
        const result=await api(`v1/presets?${query}`);items.push(...result.items);cursor=result.hasMore?result.nextCursor:null;
      } while(cursor&&!gone);
      if(!gone)setPresets(items);
    })().catch(()=>{if(!gone)setSettingsError('预设列表加载失败');});
    void api('v1/api-model-configs').then(result=>{
      if(!gone)setModelConfigs(result.items??[]);
    }).catch(()=>{if(!gone)setSettingsError('模型配置列表加载失败');});
    };
    let loadingStage=false,retryStage=false,stageError='';
    const loadStage=()=>{
    if(gone||loadedRef.current||fatalRef.current)return;
    if(loadingStage){retryStage=true;return;}
    loadingStage=true;
    void api(base).then(current=>{if(!gone){
      setTitle(current.title??'');
      setPreset(current.presetId??null);
      setModelConfig(current.apiModelConfigId??null);
      if(current.activeRun)restoreRun({...current.activeRun,runId:current.activeRun.runId??current.activeRun.id});
    }return api('v1/worlds/'+current.worldId);}).then(async world=>{
      const data=world.item.data;
      const modules=await compileWorldComponents(world.item,compileComponents);
      if(!gone&&data.stage_component&&!(data.components??[]).some((item:{id:string})=>item.id===data.stage_component))setNotice('未找到舞台主组件，已使用官方故事界面。');
      if(!gone){renderRef.current={worldId:world.item.id,modules,main:data.stage_component,rules:data.message_render?.rules??[],state:stateManifest(data.state)};loadedRef.current=true;setLoaded(true);if(stageError)setNotice(current=>current===stageError?'':current);if(ready.current&&stageSourceRef.current)port.current?.postMessage(renderPayload(stageSourceRef.current.origin));}

    }).catch(error=>{if(!gone){
      if(error instanceof ApiError){stageError=error.message;setNotice(stageError);}
      else block(error instanceof Error?error.message:'组件加载失败');
    }}).finally(()=>{loadingStage=false;if(retryStage){retryStage=false;loadStage();}});
    };
    loadStage();loadSettings();
    return()=>{gone=true;themeObserver.disconnect();matcher.close();stream.close();port.current?.close();port.current=null;window.removeEventListener('message',listener);};
  },[base,nonce,send,block,updateDraft,syncAppearance,suggestions,renderPayload]);

  useEffect(()=>{
    const abort=new AbortController();
    resetStageConnection();setStageSource(null);setStageError('');debugRef.current=false;
    void api('v1/runtime/config',{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10000)])}).then(config=>{
      if(abort.signal.aborted)return;
      debugRef.current=config.debug===true;
      const mountNonce=nonce+'.'+stageAttempt,url=stageURL(config,location.origin,mountNonce);
      setStageSource({url:url.href,origin:url.origin,nonce:mountNonce});
      stageTimer.current=setTimeout(()=>failStage('故事舞台加载超时，请确认服务可用后重试。'),10000);
    }).catch(error=>{if(!abort.signal.aborted)failStage(error instanceof Error?(error.name==='TimeoutError'?'故事舞台地址加载超时，请重试。':error.message):'故事舞台地址加载失败');});
    return()=>{abort.abort();resetStageConnection();};
  },[nonce,stageAttempt,resetStageConnection,failStage]);

  async function submit(value?:string){if(fatal||!online||!loaded||!mounted||sending||activeRun)return;const text=trimTrailingEmptyRoleplayLines(value??draft);if(!text.trim())return;const revision=draftRevision.current;try{await send(text);if(draftRevision.current===revision)updateDraft('');}catch(error){setNotice(error instanceof Error?error.message:'发送失败');}}
  async function saveSettings(){
    setSettingsSaving(true);setSettingsError('');
    const configChanged=settingsTitle.trim()!==title||settingsPreset!==(preset??'')||settingsModel!==(modelConfig??'');
    if(configChanged&&(!settingsPreset||!settingsModel||activeRun||sending)){
      setSettingsError(!settingsPreset||!settingsModel?'修改会话配置时必须选择预设和 API 模型':'生成过程中不能修改会话配置');
      setSettingsSaving(false);return;
    }
    try{
      if(configChanged){
        await api(base,{method:'PATCH',body:json({title:settingsTitle.trim()||null,presetId:settingsPreset,apiModelConfigId:settingsModel})});
        setTitle(settingsTitle.trim());setPreset(settingsPreset);setModelConfig(settingsModel);
      }
      fontSizeBeforeSettings.current=settingsFontSize;setFontSize(settingsFontSize);
      try {localStorage.setItem(fontPreferenceKey,String(settingsFontSize));}
      catch {setNotice('阅读字号已应用，但浏览器无法保存本地偏好');}
      setSettingsOpen(false);
    }
    catch(error){setSettingsError(error instanceof Error?error.message:'保存失败');
      try {const latest=await api(base+'/capabilities');setCapabilities(latest);}catch{/* Preserve the draft for retry. */}
    }
    finally{setSettingsSaving(false);}
  }
  const currentPreset=presets.find(p=>p.id===preset)?.name??'未选择预设';
  const currentModel=modelConfigs.find(m=>m.id===modelConfig)?.name??'未选择模型';
  function openSettings(){
    setSettingsTitle(title);setSettingsPreset(preset??'');setSettingsModel(modelConfig??'');setSettingsError('');
    setCapabilitiesLoading(true);
    void api(base+'/capabilities').then(value=>{
      setCapabilities(value);
    }).catch(()=>setCapabilities(null)).finally(()=>setCapabilitiesLoading(false));
    fontSizeBeforeSettings.current=fontSize;setSettingsFontSize(fontSize);setSettingsOpen(true);
  }
  function cancelSettings(){
    setFontSize(fontSizeBeforeSettings.current);setSettingsFontSize(fontSizeBeforeSettings.current);
    setSettingsOpen(false);
  }
  const settingsConfigChanged=settingsTitle.trim()!==title||settingsPreset!==(preset??'')||settingsModel!==(modelConfig??'');
  const canSaveSettings=!settingsSaving&&(!settingsConfigChanged||(!activeRun&&!sending&&!!settingsPreset&&!!settingsModel));
  const stateLabel=fatal?'舞台异常':stageError?'舞台未连接':!online?'正在连接':activeRun?({preparing:'准备中',narrative:'生成中',extensions:'整理中'} as Record<string,string>)[phase]??'生成中':'已连接';
  return <section ref={detail} className={styles.detail} data-session-detail={id}>
    <header className={styles.topbar} data-session-toolbar>
      <Link to="/sessions" className={styles.mobileBack} aria-label="返回会话列表"><ArrowLeft size={20}/></Link>
      <div className={styles.identity}><h1 title={title}>{title||'未命名会话'}</h1><span>{currentPreset} · {currentModel}</span></div>
      <div className={styles.topActions}>
        <SessionTokenUsage sessionId={id} refreshKey={usageRevision}/>
        <span className={styles.status} data-active={!!activeRun} data-error={fatal||!!stageError||!online} role="status" title={stateLabel}><i/><span>{stateLabel}</span></span>
        <button className={styles.iconButton} disabled={fatal} aria-label="会话设置" title="会话设置" onClick={openSettings}><Settings2 size={18}/></button>
      </div>
    </header>
    <div ref={stageViewport} className={styles.stageSlot} aria-label="故事舞台">
      {fatal?<div className="stage-error" role="alert"><h2>世界卡运行界面异常</h2><p>{fatalMessage}</p><Link to="/sessions">返回会话列表</Link><button onClick={()=>location.reload()}>重新加载</button></div>:
        stageError?<div className="stage-error" role="alert"><h2>故事舞台暂时无法连接</h2><p>{stageError}</p><button onClick={()=>setStageAttempt(value=>value+1)}>重试舞台</button></div>:
        stageSource?<iframe className={styles.preview} key={stageSource.nonce} ref={frame} title="会话页面" sandbox="allow-scripts allow-same-origin" src={stageSource.url} onLoad={onStageLoad}/>:<p role="status">正在连接故事舞台…</p>}
    </div>
    <div ref={composerOverlay} className={styles.composerArea} data-composer-overlay>
      {notice&&<div className={styles.previewError} role="alert">{notice}<button aria-label="关闭通知" onClick={()=>setNotice('')}>×</button></div>}
      {expanded?<form className={styles.composer} aria-label="消息输入" onSubmit={event=>{event.preventDefault();void submit();}}>
        <button type="button" className={styles.collapse} aria-label="收起输入框" onClick={()=>setExpanded(false)}><ChevronDown size={19}/></button>
        <div ref={composer} className={styles.editor}><RoleplayComposer value={draft} disabled={fatal} onChange={updateDraft} onSubmit={text=>void submit(text)}/></div>
        {activeRun?<button className={styles.send} type="button" aria-label="停止生成" disabled={stopping} onClick={()=>void stop(activeRun)}><Square size={16}/></button>:
          <button className={styles.send} type="submit" aria-label="发送消息" disabled={fatal||!online||!loaded||!mounted||sending||!draft.trim()||draft.length>100000}><Send size={18}/></button>}
      </form>:<div className={styles.collapsedActions}>
        <button ref={expandButton} className={styles.expand} aria-label="展开输入框" onClick={()=>{setExpanded(true);requestAnimationFrame(()=>composer.current?.querySelector<HTMLElement>('.sr-composer-editor')?.focus());}}><ChevronUp size={19}/></button>
        {activeRun&&<button className={styles.stopCollapsed} aria-label="停止生成" disabled={stopping} onClick={()=>void stop(activeRun)}><Square size={16}/></button>}
      </div>}
    </div>
    {settingsOpen&&<SessionSettingsDialog
      title={settingsTitle} preset={settingsPreset} model={settingsModel}
      capabilities={capabilities} capabilitiesLoading={capabilitiesLoading}
      presets={presets} models={modelConfigs} fontSize={settingsFontSize}
      saving={settingsSaving} error={settingsError} disabled={!!activeRun||sending} canSave={canSaveSettings}
      onTitleChange={setSettingsTitle} onPresetChange={setSettingsPreset} onModelChange={setSettingsModel}
      onFontSizeChange={value=>{setSettingsFontSize(value);setFontSize(value);}}
      onCancel={cancelSettings} onSave={()=>void saveSettings()}/>}
  </section>;
}
