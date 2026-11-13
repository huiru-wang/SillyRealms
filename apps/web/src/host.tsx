import React,{useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {Settings2} from 'lucide-react';
import {api,json,ApiError} from './api';
import {randomId} from './random-id';
import {RoleplayComposer} from './features/sessions/composer/RoleplayComposer';
import {SessionTokenUsage} from './features/sessions/SessionTokenUsage';
import {SessionSettingsDialog,type CapabilityView,type CapabilityOverrides} from './features/sessions/SessionSettingsDialog';
import {compile} from '@sillyrealms/ui-compiler';
import {MessageMatcher} from './message-matcher';
import {trimTrailingEmptyRoleplayLines} from '@sillyrealms/roleplay';
import type {MessageRule} from '../../../packages/sr-sdk/src/story-context';

/** Trusted bridge: it forwards commands and events without holding state or history snapshots. */
export function SessionHost({id}:{id:string}) {
  const [notice,setNotice]=useState('');
  const [title,setTitle]=useState('');
  const [preset,setPreset]=useState<string|null>(null);
  const [modelConfig,setModelConfig]=useState<string|null>(null);
  const [presets,setPresets]=useState<Array<{id:string;name:string}>>([]);
  const [modelConfigs,setModelConfigs]=useState<Array<{id:string;name:string;modelId:string}>>([]);
  const [settingsOpen,setSettingsOpen]=useState(false);
  const [settingsTitle,setSettingsTitle]=useState('');
  const [settingsPreset,setSettingsPreset]=useState('');
  const [settingsModel,setSettingsModel]=useState('');
  const [mode,setMode]=useState<'direct'|'agent'>('direct');
  const [settingsMode,setSettingsMode]=useState<'direct'|'agent'>('direct');
  const [capabilities,setCapabilities]=useState<CapabilityView|null>(null);
  const [capabilitiesLoading,setCapabilitiesLoading]=useState(false);
  const [overrides,setOverrides]=useState<CapabilityOverrides>({state_update:null,action_suggestions:null});
  const [phase,setPhase]=useState('preparing');
  const phaseRef=useRef('preparing');
  const [draftUndo,setDraftUndo]=useState<{text:string;revision:number}|null>(null);
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
  const renderRef=useRef<{code:string|null;messageCode:string|null;rules:unknown[];state:unknown}>({code:null,messageCode:null,rules:[],state:{}}),loadedRef=useRef(false);
  const terminal=useRef(new Set<string>());
  const eventSourceOpened=useRef(false);
  const nonce=useMemo(()=>randomId(),[id]);
  const updateDraft=useCallback((value:string)=>{draftRevision.current++;draftRef.current=value;setDraft(value);setDraftUndo(null);},[]);
  const base=`v1/sessions/${id}`;
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
  const block=useCallback(()=>{
    fatalRef.current=true;mountedRef.current=false;setFatal(true);setMounted(false);setFontSize(fontSizeBeforeSettings.current);setSettingsOpen(false);setNotice('');
    if(activeRef.current)void stop(activeRef.current);
  },[stop]);
  const send=useCallback(async(text:string)=>{
    if(fatalRef.current)throw Error('世界卡数据异常');
    if(!connected.current)throw Error('连接尚未就绪');
    if(!mountedRef.current)throw Error('会话页面尚未就绪');
    if(!text.trim()||text.length>100000)throw Error('请输入有效内容');
    if(sendingRef.current||activeRef.current)throw Error('当前会话正在生成');
    sendingRef.current=true;setSending(true);
    try {
      const current=await api(base);
      if(fatalRef.current)throw Error('世界卡数据异常');
      const result=await api(`${base}/runs`,{method:'POST',body:json({text,requestId:randomId(),expectedTipEntryId:current.tipEntryId})});
      if(fatalRef.current){void stop(result.runId);throw Error('世界卡数据异常');}
      if(!terminal.current.has(result.runId)){activeRef.current=result.runId;setActiveRun(result.runId);}
      else terminal.current.delete(result.runId);
      return result;
    } finally {sendingRef.current=false;setSending(false);}
  },[base,stop]);

  // Install the trusted handshake before a cached iframe can emit sr-ready.
  useLayoutEffect(()=>{
    ready.current=false;connected.current=false;mountedRef.current=false;fatalRef.current=false;activeRef.current=null;eventSourceOpened.current=false;
    draftRevision.current++;setDraft('');setExpanded(true);setFatal(false);setMounted(false);setLoaded(false);setOnline(false);setActiveRun(null);setNotice('');setSettingsOpen(false);setSettingsError('');setPresets([]);setModelConfigs([]);setModelConfig(null);setCapabilities(null);setDraftUndo(null);loadedRef.current=false;renderRef.current={code:null,messageCode:null,rules:[],state:{}};terminal.current.clear();
    const stream=new EventSource(`/api/${base}/events`);
    const matcher=new MessageMatcher();
    let recoverySequence=0;
    const restoreRun=(result:any)=>{
      if(!result||typeof result.runId!=='string')return;
      if(['completed','failed','stopped'].includes(result.status)){
        terminal.current.add(result.runId);
        if(activeRef.current===result.runId){activeRef.current=null;setActiveRun(null);}
        port.current?.postMessage({type:'event',event:{event:'run.'+result.status,data:{...result,messages:result.messages??[]}}});
      }else if(!terminal.current.has(result.runId)){
        activeRef.current=result.runId;setActiveRun(result.runId);
        phaseRef.current=result.phase??'preparing';setPhase(phaseRef.current);
        port.current?.postMessage({type:'event',event:{event:'run.phase',data:{runId:result.runId,phase:phaseRef.current}}});
      }
    };
    const recover=async()=>{
      const sequence=++recoverySequence,known=activeRef.current;
      try {
        const current=await api(base);
        if(gone||sequence!==recoverySequence)return;
        const runId=current.activeRun?.runId??current.activeRun?.id??known;
        if(runId){
          try {
            const result=await api(base+'/runs/'+encodeURIComponent(runId));
            if(!gone&&sequence===recoverySequence)restoreRun({...result,runId});
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
    stream.onopen=()=>{connected.current=true;void recover();setOnline(true);if(eventSourceOpened.current)setUsageRevision(value=>value+1);eventSourceOpened.current=true;if(ready.current)port.current?.postMessage({type:'connected'});};
    stream.onerror=()=>{connected.current=false;setOnline(false);};
    stream.addEventListener('usage.updated',()=>setUsageRevision(value=>value+1));
    for(const name of ['run.created','run.phase','run.delta','run.completed','run.failed','run.stopped','state.changed'])stream.addEventListener(name,(event:MessageEvent)=>{
      try {
        const data=JSON.parse(event.data);
        if(name.startsWith('run.') && typeof data.runId==='string'){
          if(['run.completed','run.failed','run.stopped'].includes(name)){
            terminal.current.add(data.runId);if(terminal.current.size>100){const oldest=terminal.current.values().next().value!;terminal.current.delete(oldest);}
            if(activeRef.current===data.runId){activeRef.current=null;setActiveRun(null);}
            if(name==='run.failed')setNotice('生成失败：'+String(data.errorMessage??'未知错误'));
          } else if(!terminal.current.has(data.runId)){activeRef.current=data.runId;setActiveRun(data.runId);if(data.phase){phaseRef.current=data.phase;setPhase(data.phase);}}
        }
        port.current?.postMessage({type:'event',event:{event:name,data}});
      } catch {setNotice('会话事件无效');}
    });
    const listener=(event:MessageEvent)=>{
      if(event.source!==frame.current?.contentWindow||event.data?.type!=='sr-ready'||event.data.nonce!==nonce||fatalRef.current)return;
      ready.current=false;mountedRef.current=false;setMounted(false);
      const channel=new MessageChannel();port.current?.close();port.current=channel.port1;
      channel.port1.onmessage=async message=>{
        const payload=message.data;
        if(payload.type==='ready-ack'){
          ready.current=true;if(loadedRef.current)channel.port1.postMessage({type:'render',...renderRef.current});
          channel.port1.postMessage({type:'theme',value:document.documentElement.dataset.theme??'light'});
          channel.port1.postMessage({type:'appearance',fontSize:fontSizeRef.current});
          if(connected.current)channel.port1.postMessage({type:'connected'});
        } else if(payload.type==='page-mounted'){if(!fatalRef.current){mountedRef.current=true;setMounted(true);void recover();}}
        else if(payload.type==='set-draft'){
          if(!fatalRef.current && typeof payload.text==='string' && payload.text.length<=100000){const previous=draftRef.current;updateDraft(payload.text);setExpanded(true);if(previous!==payload.text)setDraftUndo({text:previous,revision:draftRevision.current});}
        } else if(payload.type==='sdk-error')setNotice('SDK 错误：'+payload.message);
        else if(payload.type==='message-error')setNotice('消息组件加载失败，将显示原文');
        else if(payload.type==='ui-error')block();
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
            } else if(payload.method==='session.send')result=await send(payload.data?.text);
            else if(payload.method==='message.match'){
              if(typeof payload.data?.text!=='string'||!['user','assistant'].includes(payload.data?.role))throw Error('消息无效');
              result=await matcher.match(payload.data.text,payload.data.role,renderRef.current.rules as MessageRule[]);
            }
            else throw Error('不支持的命令');
            channel.port1.postMessage({type:'response',id:payload.id,data:result});
          } catch(error){channel.port1.postMessage({type:'response',id:payload.id,error:error instanceof Error?error.message:String(error)});}
        }
      };
      frame.current?.contentWindow?.postMessage({type:'sr-connect',nonce},'*',[channel.port2]);
    };
    window.addEventListener('message',listener);
    const themeObserver=new MutationObserver(()=>port.current?.postMessage({type:'theme',value:document.documentElement.dataset.theme??'light'}));
    themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
    let gone=false;
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
    void api(base).then(current=>{if(!gone){
      setTitle(current.title??'');
      setPreset(current.presetId??null);
      setModelConfig(current.apiModelConfigId??null);setMode(current.executionMode??'agent');
      if(current.activeRun)restoreRun({...current.activeRun,runId:current.activeRun.runId??current.activeRun.id});
    }return api('v1/worlds/'+current.worldId);}).then(async world=>{
      const data=world.item.data;
      const source=data.ui?.source;
      const compiled=source?await compile(source):null;
      let messageCode:string|null=null;
      if(data.message_render?.component_source){try{messageCode=await compile(data.message_render.component_source);}catch{if(!gone)setNotice('消息组件编译失败，将显示原文');}}
      if(!gone){renderRef.current={code:compiled,messageCode,rules:data.message_render?.rules??[],state:data.state??{}};loadedRef.current=true;setLoaded(true);if(ready.current)port.current?.postMessage({type:'render',...renderRef.current});}
    }).catch(()=>{if(!gone)block();});
    return()=>{gone=true;themeObserver.disconnect();matcher.close();stream.close();port.current?.close();port.current=null;window.removeEventListener('message',listener);};
  },[base,nonce,send,block,updateDraft]);

  async function submit(value?:string){if(fatal||!online||!loaded||!mounted||sending||activeRun)return;const text=trimTrailingEmptyRoleplayLines(value??draft);if(!text.trim())return;const revision=draftRevision.current;try{await send(text);if(draftRevision.current===revision)updateDraft('');}catch(error){setNotice(error instanceof Error?error.message:'发送失败');}}
  async function saveSettings(){
    setSettingsSaving(true);setSettingsError('');
    const configChanged=settingsTitle.trim()!==title||settingsPreset!==(preset??'')||settingsModel!==(modelConfig??'')||settingsMode!==mode;
    if(configChanged&&(!settingsPreset||!settingsModel||activeRun||sending)){
      setSettingsError(!settingsPreset||!settingsModel?'修改会话配置时必须选择预设和 API 模型':'生成过程中不能修改会话配置');
      setSettingsSaving(false);return;
    }
    try{
      if(configChanged){
        await api(base,{method:'PATCH',body:json({title:settingsTitle.trim()||null,presetId:settingsPreset,apiModelConfigId:settingsModel,executionMode:settingsMode})});
        setTitle(settingsTitle.trim());setPreset(settingsPreset);setModelConfig(settingsModel);setMode(settingsMode);
      }
      if(capabilities&&(overrides.state_update!==(capabilities.overrides.state_update??null)||overrides.action_suggestions!==(capabilities.overrides.action_suggestions??null))){
        const updated=await api(base+'/capabilities',{method:'PATCH',body:json({expectedRevision:capabilities.revision,overrides})});
        setCapabilities(updated);
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
    setSettingsTitle(title);setSettingsPreset(preset??'');setSettingsModel(modelConfig??'');setSettingsMode(mode);setSettingsError('');
    setCapabilitiesLoading(true);
    void api(base+'/capabilities').then(value=>{
      if(typeof value.revision!=='number')throw Error('能力设置不可用');
      setCapabilities(value);setOverrides({state_update:value.overrides.state_update??null,action_suggestions:value.overrides.action_suggestions??null});
    }).catch(()=>setCapabilities(null)).finally(()=>setCapabilitiesLoading(false));
    fontSizeBeforeSettings.current=fontSize;setSettingsFontSize(fontSize);setSettingsOpen(true);
  }
  function cancelSettings(){
    setFontSize(fontSizeBeforeSettings.current);setSettingsFontSize(fontSizeBeforeSettings.current);
    setSettingsOpen(false);
  }
  const settingsConfigChanged=settingsTitle.trim()!==title||settingsPreset!==(preset??'')||settingsModel!==(modelConfig??'')||settingsMode!==mode;
  const canSaveSettings=!settingsSaving&&(!settingsConfigChanged||(!activeRun&&!sending&&!!settingsPreset&&!!settingsModel));
  return <div className="host">
    <div className="hostbar">
      <div className="host-title">
        <strong>{title||'未命名会话'}</strong>
        <small className="host-config-summary">{currentPreset} · {currentModel} · {mode==='direct'?'Direct':'Agent'}</small>
      </div>
      <div className="host-actions">
        <span
          className={'host-run-state '+(fatal||!online?'offline':'')}
          role="status"
          aria-label={fatal?'运行异常':!online?'连接中断':activeRun?({preparing:'准备上下文…',narrative:'生成故事…',extensions:'处理状态与建议…'} as Record<string,string>)[phase]??'生成中':'已就绪'}
          title={fatal?'运行异常':!online?'连接中断':activeRun?({preparing:'准备上下文…',narrative:'生成故事…',extensions:'处理状态与建议…'} as Record<string,string>)[phase]??'生成中':'已就绪'}
        />
        <button className="host-settings-button" disabled={fatal} aria-label="会话设置" title="会话设置" aria-expanded={settingsOpen} onClick={openSettings}><Settings2 size={17} aria-hidden="true"/><span className="host-settings-label">会话设置</span></button>
      </div>
    </div>
    <SessionTokenUsage sessionId={id} refreshKey={usageRevision}/>
    {settingsOpen&&<SessionSettingsDialog
      title={settingsTitle} preset={settingsPreset} model={settingsModel} mode={settingsMode}
      capabilities={capabilities} overrides={overrides} capabilitiesLoading={capabilitiesLoading}
      onModeChange={setSettingsMode} onOverridesChange={setOverrides}
      presets={presets} models={modelConfigs} fontSize={settingsFontSize}
      saving={settingsSaving} error={settingsError} disabled={!!activeRun||sending} canSave={canSaveSettings}
      onTitleChange={setSettingsTitle} onPresetChange={setSettingsPreset} onModelChange={setSettingsModel}
      onFontSizeChange={value=>{setSettingsFontSize(value);setFontSize(value);}}
      onCancel={cancelSettings} onSave={()=>void saveSettings()}
    />}
    {notice&&<div className="notice" role="alert">{notice}{!fatal&&<button aria-label="关闭通知" onClick={()=>setNotice('')}>×</button>}</div>}
    {fatal?<div className="host-fatal" role="alert"><p>世界卡运行界面异常</p><a className="button secondary" href="/sessions">返回会话列表</a><button className="button secondary" onClick={()=>location.reload()}>重新加载</button></div>:<iframe key={nonce} ref={frame} title="会话页面" sandbox="allow-scripts" src={'/frame.html#'+nonce}/>}
    <div className="host-composer">
      {draftUndo&&draftUndo.revision===draftRevision.current&&<div className="host-draft-undo" role="status">已填入草稿<button onClick={()=>{if(draftUndo.revision===draftRevision.current)updateDraft(draftUndo.text);}}>撤销</button></div>}
      {activeRun&&<p className="host-phase" role="status">{({preparing:'正在准备上下文，必要时整理历史…',narrative:'正在生成故事…',extensions:'正文已生成，正在处理状态与建议…'} as Record<string,string>)[phase]??'正在生成…'}</p>}
      {expanded?<><RoleplayComposer value={draft} disabled={fatal} onChange={updateDraft} onSubmit={text=>void submit(text)}/>
      <div className="host-composer-actions">
        <button className="button host-collapse-input" title="收起输入区" onClick={()=>setExpanded(false)}>收起</button>
        {activeRun?<button className="button secondary host-send-button" disabled={stopping} onClick={()=>void stop(activeRun)}>{stopping?'停止中…':'停止生成'}</button>:<button className="button primary host-send-button" disabled={fatal||!online||!loaded||!mounted||sending||!draft.trim()||draft.length>100000} onClick={()=>void submit()}>发送</button>}
      </div></>:<button ref={expandButton} className="button secondary" onClick={()=>setExpanded(true)}>展开输入区</button>}
    </div>
  </div>;
}
