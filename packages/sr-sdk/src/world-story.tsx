import React,{useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {useSRSession,useSRStateAPI} from './atomic-context.js';
import {useStoryConfiguration} from './story-context.js';
import {applyRunEvent,displayMessages,hasDeltaGap,mergeHistory,mergeInitial} from './story-history.js';
import {captureScrollAnchor,restoreScrollAnchor} from './story-scroll.js';
import type {Run,SessionRunEvent,StateScope,StateValue} from './index.js';
import {MessageContent} from './message-content.js';

function StatePanel({close,mobile}:{close:()=>void;mobile:boolean}){
  const config=useStoryConfiguration(),state=useSRStateAPI();
  const panel=useRef<HTMLElement>(null),closeButton=useRef<HTMLButtonElement>(null);
  const [values,setValues]=useState<Array<{path:string;scope:StateScope;value:StateValue|undefined}>>([]);
  const [loading,setLoading]=useState(false),[error,setError]=useState(false),[retry,setRetry]=useState(0);
  const definitions=config.state as {scopes?:Partial<Record<StateScope,Record<string,unknown>>>};
  const entries=(['global','session','message'] as StateScope[]).flatMap(scope=>Object.keys(definitions.scopes?.[scope]??{}).map(path=>({scope,path})));
  const signature=JSON.stringify(entries);
  useEffect(()=>{if(mobile)closeButton.current?.focus();},[mobile]);
  useEffect(()=>{
    let live=true;let sequence=0;
    const read=()=>{const current=++sequence;if(entries.length)setLoading(true);void state.batchGetState(entries).then(value=>{if(live&&current===sequence){setValues(value);setError(false);setLoading(false);}}).catch(()=>{if(live&&current===sequence){setError(true);setLoading(false);}});};
    read();const unsubscribe=state.subscribe(read);
    return()=>{live=false;unsubscribe();};
  // The signature represents the stable path list.
  },[state,signature,retry]);
  const labels:Record<StateScope,string>={global:'世界状态',session:'会话状态',message:'消息状态'};
  return <aside ref={panel} className="sr-story-state" role={mobile?'dialog':undefined} aria-modal={mobile||undefined} aria-label="会话状态" onKeyDown={event=>{
    if(!mobile)return;
    if(event.key==='Escape'){event.preventDefault();close();return;}
    if(event.key==='Tab'){
      const controls=Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),summary,[tabindex]:not([tabindex="-1"])')??[]);
      const first=controls[0],last=controls.at(-1);if(!first||!last)return;
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    }
  }}><button ref={closeButton} onClick={close}>收起状态</button><h2>状态</h2>{error?<p role="alert">状态加载失败 <button onClick={()=>setRetry(value=>value+1)}>重试</button></p>:loading&&!values.length?<p>正在加载状态…</p>:values.length?(['global','session','message'] as StateScope[]).map(scope=>{
    const items=values.filter(item=>item.scope===scope);return items.length?<details key={scope} open><summary>{labels[scope]}</summary>{items.map(item=><div key={item.path}><span>{item.path}</span><code>{item.value===undefined?'—':typeof item.value==='string'?item.value:JSON.stringify(item.value)}</code></div>)}</details>:null;
  }):<p>暂无状态</p>}</aside>;
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
    <span className="sr-avatar">{message.role==='user'?'我':'✦'}</span>
    <div className="sr-bubble"><MessageContent message={message} runId={run.id}/></div>
  </article>)}<RunFeedback run={run} current={current} onChoose={onChoose}/></>;
});
export function WorldStory({showState=true}:{showState?:boolean}={}){
  const session=useSRSession(),config=useStoryConfiguration();
  const [runs,setRuns]=useState<Run[]>([]),[cursor,setCursor]=useState<string|null>(null),[more,setMore]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[stateOpen,setStateOpen]=useState(()=>window.matchMedia('(min-width: 761px)').matches);
  const [retry,setRetry]=useState(0),[loadingMore,setLoadingMore]=useState(false),[historyError,setHistoryError]=useState('');
  const runsRef=useRef<Run[]>([]),historyEpoch=useRef(0);
  const updateRuns=useCallback((next:Run[])=>{runsRef.current=next;setRuns(next);},[]);
  const chooseSuggestion=useCallback((text:string)=>session.setDraft(text),[session]);
  const view=useRef<HTMLDivElement>(null);
  const stateButton=useRef<HTMLButtonElement>(null);
  const [mobile,setMobile]=useState(()=>window.matchMedia('(max-width: 760px)').matches);
  const stickToEnd=useRef(true);
  const initialPositionPending=useRef(true);
  const loadingMoreRef=useRef(false);
  const pendingScrollAnchor=useRef<ReturnType<typeof captureScrollAnchor>|null>(null);
  const fontChangeSnapshot=useRef<{anchor:ReturnType<typeof captureScrollAnchor>;wasAtEnd:boolean}|null>(null);
  const [showLatest,setShowLatest]=useState(false);
  useEffect(()=>{const query=window.matchMedia('(max-width: 760px)');const update=()=>setMobile(query.matches);query.addEventListener('change',update);return()=>query.removeEventListener('change',update);},[]);
  const closeState=()=>{setStateOpen(false);requestAnimationFrame(()=>stateButton.current?.focus());};
  useEffect(()=>{
    const before=()=>{
      const element=view.current;if(!element)return;
      fontChangeSnapshot.current={anchor:captureScrollAnchor(element),wasAtEnd:element.scrollHeight-element.scrollTop-element.clientHeight<64};
    };
    const after=()=>{
      const snapshot=fontChangeSnapshot.current;fontChangeSnapshot.current=null;
      if(!snapshot)return;
      // Reading geometry flushes the new font's layout synchronously. An
      // obscured iframe may defer animation frames while Host's modal is open.
      const element=view.current;if(!element)return;
      if(snapshot.wasAtEnd){element.scrollTop=element.scrollHeight;stickToEnd.current=true;setShowLatest(false);}
      else if(snapshot.anchor.messageId)restoreScrollAnchor(element,snapshot.anchor);
    };
    window.addEventListener('sr:font-size-will-change',before);
    window.addEventListener('sr:font-size-changed',after);
    return()=>{
      window.removeEventListener('sr:font-size-will-change',before);
      window.removeEventListener('sr:font-size-changed',after);
    };
  },[]);
  useEffect(()=>{
    let live=true,initial=true,syncing=false;
    let frame:number|undefined,timer:ReturnType<typeof setTimeout>|undefined;
    const pending:SessionRunEvent[]=[];
    historyEpoch.current++;
    initialPositionPending.current=true;
    stickToEnd.current=true;
    pendingScrollAnchor.current=null;
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
      initialPositionPending.current=false;
      stickToEnd.current=true;
      setShowLatest(false);
      return;
    }
    if(pendingScrollAnchor.current){
      const anchor=pendingScrollAnchor.current;
      pendingScrollAnchor.current=null;
      restoreScrollAnchor(element,anchor);
      return;
    }
    if(stickToEnd.current)element.scrollTop=element.scrollHeight;
  },[runs,loading]);
  useEffect(()=>{
    const element=view.current;if(!element)return;
    // Images and asynchronous custom rendering can change height after a React commit.
    const resize=new ResizeObserver(()=>{
      if(stickToEnd.current&&!initialPositionPending.current&&!pendingScrollAnchor.current)
        element.scrollTop=element.scrollHeight;
    });
    const observe=()=>{resize.disconnect();resize.observe(element);for(const child of element.children)resize.observe(child);};
    const mutations=new MutationObserver(observe);mutations.observe(element,{childList:true});observe();
    return()=>{resize.disconnect();mutations.disconnect();};
  },[]);
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
  return <div className="sr-story"><div className="sr-story-main"><div className="sr-story-toolbar"><span>故事</span>{showState&&<button ref={stateButton} onClick={()=>setStateOpen(open=>!open)} aria-expanded={stateOpen}>状态 {stateOpen?'收起':'展开'}</button>}</div><div className="sr-chat-messages" ref={view} onScroll={event=>{if(initialPositionPending.current)return;const element=event.currentTarget;stickToEnd.current=element.scrollHeight-element.scrollTop-element.clientHeight<64;setShowLatest(!stickToEnd.current);}}>{more&&<button className="sr-more" disabled={loadingMore} onClick={()=>void loadMore()}>{loadingMore?'正在加载…':historyError?'重试加载':'加载更早消息'}</button>}{historyError&&<p className="sr-error" role="alert">{historyError}</p>}{loading&&<p>正在加载故事…</p>}{error&&<p className="sr-error" role="alert">{error} <button onClick={()=>setRetry(value=>value+1)}>重试</button></p>}{!loading&&!error&&!runs.length&&<p>故事尚未开始。</p>}{runs.map(run=><StoryRun key={run.id} run={run} current={runs.at(-1)?.id===run.id} onChoose={chooseSuggestion}/>)}</div>{showLatest&&<button className="sr-more" onClick={()=>{stickToEnd.current=true;if(view.current)view.current.scrollTo({top:view.current.scrollHeight,behavior:'smooth'});setShowLatest(false);}}>回到最新</button>}</div>{showState&&stateOpen&&<>{mobile&&<button className="sr-story-backdrop" aria-label="关闭状态" tabIndex={-1} onClick={closeState}/>}<StatePanel close={closeState} mobile={mobile}/></>}</div>;
}
