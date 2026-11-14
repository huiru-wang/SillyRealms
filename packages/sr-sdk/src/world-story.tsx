import React,{useCallback,useEffect,useLayoutEffect,useId,useMemo,useRef,useState} from 'react';
import {useSRSession,useSRStateAPI} from './atomic-context.js';
import {useStoryConfiguration} from './story-context.js';
import {applyRunEvent,displayMessages,hasDeltaGap,mergeHistory,mergeInitial} from './story-history.js';
import {captureScrollAnchor,restoreScrollAnchor} from './story-scroll.js';
import type {Run,SessionRunEvent,StateScope,StateValue} from './index.js';
import {MessageContent} from './message-content.js';

function StatePanel({close,restoreFocus,overlay,id}:{close:()=>void;restoreFocus:()=>void;overlay:boolean;id:string}){
  const config=useStoryConfiguration(),state=useSRStateAPI();
  const dialog=useRef<HTMLDialogElement>(null),aside=useRef<HTMLElement>(null),closeButton=useRef<HTMLButtonElement>(null);
  const [values,setValues]=useState<Array<{path:string;scope:StateScope;value:StateValue|undefined}>>([]);
  const [loading,setLoading]=useState(false),[error,setError]=useState(false),[retry,setRetry]=useState(0);
  const definitions=config.state as {scopes?:Partial<Record<StateScope,Record<string,unknown>>>};
  const entries=(['global','session','message'] as StateScope[]).flatMap(scope=>Object.keys(definitions.scopes?.[scope]??{}).map(path=>({scope,path})));
  const signature=JSON.stringify(entries);
  useLayoutEffect(()=>{
    const element=overlay?dialog.current:aside.current;if(!element)return;
    if(overlay){dialog.current!.showModal();closeButton.current?.focus({preventScroll:true});}
    return()=>{
      const hadFocus=element.contains(document.activeElement);
      if(element instanceof HTMLDialogElement&&element.open)element.close();
      // Deletion happens after this cleanup, so this also covers showState=false
      // when both the panel and its trigger disappear in the same render.
      if(hadFocus)restoreFocus();
    };
  },[overlay,restoreFocus]);
  useEffect(()=>{
    let live=true;let sequence=0;
    const read=()=>{const current=++sequence;if(entries.length)setLoading(true);void state.batchGetState(entries).then(value=>{if(live&&current===sequence){setValues(value);setError(false);setLoading(false);}}).catch(()=>{if(live&&current===sequence){setError(true);setLoading(false);}});};
    read();const unsubscribe=state.subscribe(read);
    return()=>{live=false;unsubscribe();};
  // The signature represents the stable path list.
  },[state,signature,retry]);
  function wrapModalFocus(event:React.KeyboardEvent<HTMLDialogElement>){
    if(event.key!=='Tab')return;
    const element=event.currentTarget;
    const controls=Array.from(element.querySelectorAll<HTMLElement>('button:not(:disabled),summary,[tabindex]:not([tabindex="-1"])')).filter(control=>control.tabIndex>=0&&control.getClientRects().length>0);
    const first=controls[0],last=controls.at(-1);if(!first||!last)return;
    const active=element.ownerDocument.activeElement;
    if(event.shiftKey&&(active===first||active===element)){event.preventDefault();last.focus({preventScroll:true});}
    else if(!event.shiftKey&&(active===last||active===element)){event.preventDefault();first.focus({preventScroll:true});}
  }
  const labels:Record<StateScope,string>={global:'世界状态',session:'会话状态',message:'当前剧情'};
  const content=<>
    <header className="sr-state-heading"><h2 id={id+'-title'}>会话状态</h2><button ref={closeButton} type="button" onClick={close} aria-label="收起状态">收起</button></header>
    <div className="sr-state-content">
      {error?<p className="sr-state-error" role="alert">状态加载失败 <button type="button" onClick={()=>setRetry(value=>value+1)}>重试</button></p>
      :loading&&!values.length?<p className="sr-state-empty" role="status">正在加载状态…</p>
      :values.length?(['global','session','message'] as StateScope[]).map(scope=>{
        const items=values.filter(item=>item.scope===scope);
        return items.length?<details className="sr-state-group" key={scope} open><summary>{labels[scope]}</summary><dl>{items.map(item=><div className="sr-state-value" key={item.path}><dt>{item.path}</dt><dd><code>{item.value===undefined?'—':typeof item.value==='string'?item.value:JSON.stringify(item.value,null,2)}</code></dd></div>)}</dl></details>:null;
      }):<p className="sr-state-empty">暂无状态</p>}
    </div>
  </>;
  return overlay
    ?<dialog ref={dialog} id={id} className="sr-story-state sr-story-dialog" aria-labelledby={id+'-title'} onKeyDown={wrapModalFocus} onCancel={event=>{event.preventDefault();close();}} onClick={event=>{
      if(event.target!==event.currentTarget)return;
      const rect=event.currentTarget.getBoundingClientRect();
      if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)close();
    }}>{content}</dialog>
    :<aside ref={aside} id={id} className="sr-story-state" aria-labelledby={id+'-title'}>{content}</aside>;
}

function RunFeedback({run,current,onChoose}:{run:Run;current:boolean;onChoose:(text:string)=>void}){
  const suggestions=run.extensions?.actionSuggestions;
  const state=run.extensions?.stateUpdate;
  const busy=run.status==='preparing'||run.status==='running';
  return <>
    {busy&&<p className="sr-thinking" role="status">{run.phase==='extensions'?'正文已生成，正在处理状态与建议…':run.phase==='preparing'?'正在准备上下文…':'正在生成故事…'}</p>}
    {run.status==='failed'&&<p className="sr-error">{run.messages.some(message=>message.role==='assistant'&&message.text)?'本次生成失败，已保存的正文已保留。':'本次生成失败，本轮没有已保存的正文。'}</p>}
    {run.status==='stopped'&&<p className="sr-thinking">已停止生成{run.executionMode==='direct'?'，本轮未提交状态更新。':''}</p>}
    {state?.status==='partial'&&<p className="sr-thinking">部分状态更新未通过校验，已保存有效部分，本轮不提供行动建议。</p>}
    {state?.status==='disabled'&&<p className="sr-thinking">本轮未启用状态更新。</p>}
    {suggestions?.status==='failed'&&run.status==='completed'&&<p className="sr-thinking">本轮行动建议不可用，可以继续输入。</p>}
    {suggestions?.status==='ready'&&suggestions.items.length>0&&<section className="sr-suggestions" aria-label="行动建议">
      <span>{current&&run.status==='completed'?'选择一项填入草稿':'此前的行动建议'}</span>
      <div>{suggestions.items.map((item,index)=><button key={index} disabled={!current||run.status!=='completed'} title={!current?'故事已推进，此建议已失效':undefined} onClick={()=>onChoose(item)}>{item}</button>)}</div>
    </section>}
  </>;
}
const StoryRun = React.memo(function StoryRun({run,current,onChoose}:{run:Run;current:boolean;onChoose:(text:string)=>void}) {
  const messages = useMemo(() => displayMessages(run.messages), [run.messages]);
  return <>{messages.map(message=><article className={'sr-message '+message.role} data-message-id={message.id} key={message.id}>
    <span className="sr-message-source">{message.role==='user'?'我':'故事'}</span>
    <div className="sr-story-content"><MessageContent message={message} runId={run.id}/></div>
  </article>)}<RunFeedback run={run} current={current} onChoose={onChoose}/></>;
});
export function WorldStory({showState=true}:{showState?:boolean}={}){
  const session=useSRSession(),config=useStoryConfiguration();
  const panelId=useId();
  const [runs,setRuns]=useState<Run[]>([]),[cursor,setCursor]=useState<string|null>(null),[more,setMore]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const [stateOpen,setStateOpen]=useState(false),[docked,setDocked]=useState(false);
  const [retry,setRetry]=useState(0),[loadingMore,setLoadingMore]=useState(false),[historyError,setHistoryError]=useState('');
  const runsRef=useRef<Run[]>([]),historyEpoch=useRef(0);
  const updateRuns=useCallback((next:Run[])=>{runsRef.current=next;setRuns(next);},[]);
  const chooseSuggestion=useCallback((text:string)=>session.setDraft(text),[session]);
  const root=useRef<HTMLDivElement>(null),view=useRef<HTMLDivElement>(null);
  const stateButton=useRef<HTMLButtonElement>(null);
  const dockedMode=useRef<boolean|null>(null),dockedPreference=useRef(true);
  const showStateRef=useRef(showState);showStateRef.current=showState;
  const stickToEnd=useRef(true),initialPositionPending=useRef(true),loadingMoreRef=useRef(false);
  const pendingScrollAnchor=useRef<ReturnType<typeof captureScrollAnchor>|null>(null);
  const readingPosition=useRef<{anchor:ReturnType<typeof captureScrollAnchor>;width:number;height:number;scrollHeight:number}|null>(null);
  const userScrollIntent=useRef(false),latestRequested=useRef(false);
  const restoredScrollTop=useRef<number|null>(null);
  const repairFrame=useRef<number|undefined>(undefined);
  const [showLatest,setShowLatest]=useState(false);

  const rememberReading=useCallback(()=>{
    const element=view.current;if(!element||initialPositionPending.current)return;
    readingPosition.current={anchor:captureScrollAnchor(element),width:element.clientWidth,height:element.clientHeight,scrollHeight:element.scrollHeight};
  },[]);
  const restoreReading=useCallback(()=>{
    const element=view.current;if(!element||initialPositionPending.current||pendingScrollAnchor.current)return;
    const previousTop=element.scrollTop;
    if(stickToEnd.current){element.scrollTop=element.scrollHeight;setShowLatest(false);}
    else if(readingPosition.current)restoreScrollAnchor(element,readingPosition.current.anchor);
    if(element.scrollTop!==previousTop)restoredScrollTop.current=element.scrollTop;
    rememberReading();
  },[rememberReading]);
  const scheduleRestore=useCallback(()=>{
    if(repairFrame.current!==undefined)return;
    repairFrame.current=requestAnimationFrame(()=>{repairFrame.current=undefined;restoreReading();});
  },[restoreReading]);
  const focusStateTrigger=useCallback(()=>{
    requestAnimationFrame(()=>{(stateButton.current??view.current)?.focus({preventScroll:true});});
  },[]);
  const closeState=useCallback(()=>{
    rememberReading();
    if(dockedMode.current)dockedPreference.current=false;
    setStateOpen(false);focusStateTrigger();
  },[rememberReading,focusStateTrigger]);

  useLayoutEffect(()=>{
    const element=root.current;if(!element)return;
    const measure=()=>{
      const next=element.clientWidth>=960;
      if(next===dockedMode.current)return;
      const panelHadFocus=!!element.querySelector('.sr-story-state')?.contains(document.activeElement);
      dockedMode.current=next;setDocked(next);
      setStateOpen(showStateRef.current&&next&&dockedPreference.current);
      if(panelHadFocus)focusStateTrigger();
    };
    measure();const observer=new ResizeObserver(measure);observer.observe(element);
    return()=>observer.disconnect();
  },[focusStateTrigger]);
  useLayoutEffect(()=>{
    if(!showState){
      const hadFocus=!!root.current?.querySelector('.sr-story-state')?.contains(document.activeElement);
      setStateOpen(false);if(hadFocus)focusStateTrigger();
    }else setStateOpen(!!dockedMode.current&&dockedPreference.current);
  },[showState,focusStateTrigger]);
  useLayoutEffect(()=>{restoreReading();},[stateOpen,docked,showState,restoreReading]);

  useEffect(()=>{
    const before=()=>rememberReading();
    // Keep this synchronous: the Host's settings dialog can obscure the frame,
    // delaying animation frames even though the font has already changed.
    const after=()=>restoreReading();
    window.addEventListener('sr:font-size-will-change',before);
    window.addEventListener('sr:font-size-changed',after);
    return()=>{
      window.removeEventListener('sr:font-size-will-change',before);
      window.removeEventListener('sr:font-size-changed',after);
    };
  },[rememberReading,restoreReading]);
  useEffect(()=>{
    let live=true,initial=true,syncing=false;
    let frame:number|undefined,timer:ReturnType<typeof setTimeout>|undefined;
    const pending:SessionRunEvent[]=[];
    historyEpoch.current++;
    initialPositionPending.current=true;
    stickToEnd.current=true;
    pendingScrollAnchor.current=null;readingPosition.current=null;latestRequested.current=false;restoredScrollTop.current=null;userScrollIntent.current=false;
    loadingMoreRef.current=false;setLoadingMore(false);
    updateRuns([]);setCursor(null);setMore(false);setHistoryError('');
    setLoading(true);setError('');
    const cancelFrame=()=>{if(frame!==undefined)cancelAnimationFrame(frame);clearTimeout(timer);frame=undefined;timer=undefined;};
    const synchronize=(missed:SessionRunEvent[])=>{
      syncing=true;
      void session.getHistoryRuns({limit:5}).then(result=>{
        if(!live)return;
        const snapshot=mergeHistory(runsRef.current,result.runs);
        const events=[...missed,...pending.splice(0)],next=mergeInitial(snapshot,events);
        updateRuns(next);
        setError(events.some(event=>hasDeltaGap(next,event))?'消息同步失败，请重试':'');syncing=false;
      }).catch(()=>{
        if(!live)return;
        const events=[...missed,...pending.splice(0)],next=mergeInitial(runsRef.current,events);
        updateRuns(next);syncing=false;
        setError(events.some(event=>hasDeltaGap(next,event))?'消息同步失败，请重试':'');
      });
    };
    const flush=()=>{
      cancelFrame();
      if(!live||initial||syncing)return;
      const batch=pending.splice(0);
      let next=runsRef.current,gap=false;
      for(const event of batch){
        if(hasDeltaGap(next,event)){gap=true;continue;}
        next=applyRunEvent(next,event);
      }
      updateRuns(next);
      if(gap)synchronize(batch);
    };
    const unsubscribe=session.subscribe(event=>{
      if(!live)return;
      pending.push(event);
      if(!initial&&['run.completed','run.failed','run.stopped'].includes(event.event)){
        cancelFrame();updateRuns(mergeInitial(runsRef.current,pending.splice(0)));setError('');return;
      }
      if(initial||syncing)return;
      if(event.event!=='run.delta'){flush();return;}
      if(frame===undefined){frame=requestAnimationFrame(flush);timer=setTimeout(flush,100);}
    },{includePhase:true});
    void session.getHistoryRuns({limit:5}).then(result=>{
      if(!live)return;
      const events=pending.splice(0),next=mergeInitial(result.runs,events);
      updateRuns(next);setCursor(result.nextCursor);setMore(result.hasMore);initial=false;
      if(events.some(event=>hasDeltaGap(next,event)))synchronize(events);
      setLoading(false);config.ready();
    }).catch(()=>{if(live){initial=false;pending.length=0;setLoading(false);setError('历史消息加载失败');}});
    return()=>{live=false;historyEpoch.current++;cancelFrame();pending.length=0;unsubscribe();};
  },[session,retry,updateRuns]);
  useLayoutEffect(()=>{
    const element=view.current;
    if(!element)return;
    if(initialPositionPending.current){
      if(loading)return;
      element.scrollTop=element.scrollHeight;
      initialPositionPending.current=false;stickToEnd.current=true;setShowLatest(false);
      rememberReading();return;
    }
    if(pendingScrollAnchor.current){
      const anchor=pendingScrollAnchor.current;pendingScrollAnchor.current=null;
      const previousTop=element.scrollTop;
      restoreScrollAnchor(element,anchor);
      if(element.scrollTop!==previousTop)restoredScrollTop.current=element.scrollTop;
      rememberReading();return;
    }
    restoreReading();
  },[runs,loading,rememberReading,restoreReading]);
  useEffect(()=>{
    const element=view.current;if(!element)return;
    // Keep the last settled message anchor. Observer callbacks run *after*
    // layout, so capturing here would lose the position before an image/reflow.
    const resize=new ResizeObserver(scheduleRestore);
    const observe=()=>{resize.disconnect();resize.observe(element);for(const child of element.children)resize.observe(child);};
    const mutations=new MutationObserver(observe);mutations.observe(element,{childList:true});observe();
    return()=>{
      resize.disconnect();mutations.disconnect();
      if(repairFrame.current!==undefined)cancelAnimationFrame(repairFrame.current);
      repairFrame.current=undefined;
    };
  },[scheduleRestore]);

  function userScroll(){
    restoredScrollTop.current=null;
    if(latestRequested.current&&view.current)view.current.scrollTo({top:view.current.scrollTop,behavior:'auto'});
    latestRequested.current=false;userScrollIntent.current=true;
  }
  function scrolled(){
    const element=view.current;if(!element||initialPositionPending.current)return;
    const saved=readingPosition.current;
    const restoredTop=restoredScrollTop.current;restoredScrollTop.current=null;
    const geometryChanged=saved&&(saved.width!==element.clientWidth||saved.height!==element.clientHeight||saved.scrollHeight!==element.scrollHeight);
    if(geometryChanged&&!userScrollIntent.current){scheduleRestore();return;}
    // A layout repair may move a reader inside the 64px threshold. Consume only
    // its own scroll event; it must not opt that reader back into following.
    if(!userScrollIntent.current&&restoredTop!==null&&element.scrollTop===restoredTop)return;
    const atEnd=element.scrollHeight-element.scrollTop-element.clientHeight<64;
    if(latestRequested.current&&!atEnd&&!userScrollIntent.current)return;
    latestRequested.current=false;userScrollIntent.current=false;
    stickToEnd.current=atEnd;setShowLatest(!atEnd);rememberReading();
  }
  function latest(){
    restoredScrollTop.current=null;
    stickToEnd.current=true;latestRequested.current=true;setShowLatest(false);
    const element=view.current;
    element?.focus({preventScroll:true});
    element?.scrollTo({top:element.scrollHeight,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
  }
  async function loadMore(){
    if(!cursor||loadingMoreRef.current)return;
    const epoch=historyEpoch.current;
    loadingMoreRef.current=true;
    stickToEnd.current=false;
    setLoadingMore(true);
    setHistoryError('');
    try {
      const result=await session.getHistoryRuns({limit:5,cursor});
      if(epoch!==historyEpoch.current)return;
      const element=view.current;
      if(element)pendingScrollAnchor.current=captureScrollAnchor(element);
      const current=runsRef.current,ids=new Set(current.map(run=>run.id));
      updateRuns([...result.runs.filter(run=>!ids.has(run.id)),...current]);
      setCursor(result.nextCursor);
      setMore(result.hasMore);
    }catch{
      if(epoch!==historyEpoch.current)return;
      pendingScrollAnchor.current=null;
      setHistoryError('加载历史失败，请重试');
    }finally{
      if(epoch===historyEpoch.current){
      loadingMoreRef.current=false;
      setLoadingMore(false);
      }
    }
  }
  return <div ref={root} className="sr-story" data-state-mode={docked?'docked':'overlay'}>
    <div className="sr-story-main">
      <div className="sr-story-toolbar">
        <span className="sr-story-heading">故事</span>
        {showState&&<button ref={stateButton} type="button" onClick={()=>{
          rememberReading();
          const next=!stateOpen;if(docked)dockedPreference.current=next;setStateOpen(next);
        }} aria-controls={panelId} aria-expanded={stateOpen}>状态 <span aria-hidden="true">{stateOpen?'−':'+'}</span></button>}
      </div>
      <div className="sr-chat-messages" ref={view} tabIndex={0} role="region" aria-label="故事内容" aria-busy={loading||undefined}
        onScroll={scrolled} onWheel={userScroll} onTouchMove={userScroll}
        onPointerDown={event=>{if(event.target===event.currentTarget)userScroll();}}
        onKeyDown={event=>{if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key))userScroll();}}>
        {more&&<button className="sr-more" type="button" disabled={loadingMore} onClick={()=>void loadMore()}>{loadingMore?'正在加载…':historyError?'重试加载':'加载更早消息'}</button>}
        {historyError&&<p className="sr-error" role="alert">{historyError}</p>}
        {loading&&<p className="sr-story-empty" role="status">正在加载故事…</p>}
        {error&&<p className="sr-error" role="alert">{error} <button type="button" onClick={()=>setRetry(value=>value+1)}>重试</button></p>}
        {!loading&&!error&&!runs.length&&<p className="sr-story-empty">故事尚未开始。</p>}
        {runs.map(run=><StoryRun key={run.id} run={run} current={runs.at(-1)?.id===run.id} onChoose={chooseSuggestion}/>)}
      </div>
      {showLatest&&<div className="sr-story-latest"><button className="sr-more" type="button" onClick={latest}>回到最新 <span aria-hidden="true">↓</span></button></div>}
    </div>
    {showState&&stateOpen&&<StatePanel id={panelId} close={closeState} restoreFocus={focusStateTrigger} overlay={!docked}/>}
  </div>;
}
