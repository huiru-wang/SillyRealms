import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {useSRSession,useSRStateAPI} from './atomic-context.js';
import {useStoryConfiguration} from './story-context.js';
import {applyRunEvent,displayMessages,mergeInitial} from './story-history.js';
import {captureScrollAnchor,restoreScrollAnchor} from './story-scroll.js';
import type {Run,RunEvent,StateScope,StateValue} from './index.js';
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

export function WorldStory({showState=true}:{showState?:boolean}={}){
  const session=useSRSession(),config=useStoryConfiguration();
  const [runs,setRuns]=useState<Run[]>([]),[cursor,setCursor]=useState<string|null>(null),[more,setMore]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[stateOpen,setStateOpen]=useState(()=>window.matchMedia('(min-width: 761px)').matches);
  const [retry,setRetry]=useState(0),[loadingMore,setLoadingMore]=useState(false),[historyError,setHistoryError]=useState('');
  const view=useRef<HTMLDivElement>(null);
  const stateButton=useRef<HTMLButtonElement>(null);
  const [mobile,setMobile]=useState(()=>window.matchMedia('(max-width: 760px)').matches);
  const stickToEnd=useRef(true);
  const initialPositionPending=useRef(true);
  const loadingMoreRef=useRef(false);
  const pendingScrollAnchor=useRef<ReturnType<typeof captureScrollAnchor>|null>(null);
  const [showLatest,setShowLatest]=useState(false);
  useEffect(()=>{const query=window.matchMedia('(max-width: 760px)');const update=()=>setMobile(query.matches);query.addEventListener('change',update);return()=>query.removeEventListener('change',update);},[]);
  const closeState=()=>{setStateOpen(false);requestAnimationFrame(()=>stateButton.current?.focus());};
  useEffect(()=>{
    let live=true,initial=true;const pending:RunEvent[]=[];
    initialPositionPending.current=true;
    stickToEnd.current=true;
    pendingScrollAnchor.current=null;
    setRuns([]);setCursor(null);setMore(false);setHistoryError('');
    setLoading(true);setError('');
    const unsubscribe=session.subscribe(event=>{if(initial)pending.push(event);else if(live)setRuns(previous=>applyRunEvent(previous,event));});
    void session.getHistoryRuns({limit:5}).then(result=>{
      if(!live)return;setRuns(mergeInitial(result.runs,pending));setCursor(result.nextCursor);setMore(result.hasMore);initial=false;setLoading(false);config.ready();
    }).catch(()=>{if(live){initial=false;setLoading(false);setError('历史消息加载失败');}});
    return()=>{live=false;unsubscribe();};
  },[session,retry]);
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
  async function loadMore(){
    if(!cursor||loadingMoreRef.current)return;
    loadingMoreRef.current=true;
    stickToEnd.current=false;
    setLoadingMore(true);
    setHistoryError('');
    try {
      const result=await session.getHistoryRuns({limit:5,cursor});
      const element=view.current;
      if(element)pendingScrollAnchor.current=captureScrollAnchor(element);
      setRuns(current=>{
        const ids=new Set(current.map(run=>run.id));
        return [...result.runs.filter(run=>!ids.has(run.id)),...current];
      });
      setCursor(result.nextCursor);
      setMore(result.hasMore);
    }catch{
      pendingScrollAnchor.current=null;
      setHistoryError('加载历史失败，请重试');
    }finally{
      loadingMoreRef.current=false;
      setLoadingMore(false);
    }
  }
  return <div className="sr-story"><div className="sr-story-main"><div className="sr-story-toolbar"><span>故事</span>{showState&&<button ref={stateButton} onClick={()=>setStateOpen(open=>!open)} aria-expanded={stateOpen}>状态 {stateOpen?'收起':'展开'}</button>}</div><div className="sr-chat-messages" ref={view} onScroll={event=>{if(initialPositionPending.current)return;const element=event.currentTarget;stickToEnd.current=element.scrollHeight-element.scrollTop-element.clientHeight<64;setShowLatest(!stickToEnd.current);}}>{more&&<button className="sr-more" disabled={loadingMore} onClick={()=>void loadMore()}>{loadingMore?'正在加载…':historyError?'重试加载':'加载更早消息'}</button>}{historyError&&<p className="sr-error" role="alert">{historyError}</p>}{loading&&<p>正在加载故事…</p>}{error&&<p className="sr-error" role="alert">{error} <button onClick={()=>setRetry(value=>value+1)}>重试</button></p>}{!loading&&!error&&!runs.length&&<p>故事尚未开始。</p>}{runs.map(run=><React.Fragment key={run.id}>{displayMessages(run.messages).map(message=><article className={'sr-message '+message.role} data-message-id={message.id} key={message.id}><span className="sr-avatar">{message.role==='user'?'我':'✦'}</span><div className="sr-bubble"><MessageContent message={message} runId={run.id}/></div></article>)}{run.status==='failed'&&<p className="sr-error">本次生成失败</p>}{run.status==='stopped'&&<p className="sr-thinking">已停止生成</p>}</React.Fragment>)}</div>{showLatest&&<button className="sr-more" onClick={()=>{stickToEnd.current=true;if(view.current)view.current.scrollTo({top:view.current.scrollHeight,behavior:'smooth'});setShowLatest(false);}}>回到最新</button>}</div>{showState&&stateOpen&&<>{mobile&&<button className="sr-story-backdrop" aria-label="关闭状态" tabIndex={-1} onClick={closeState}/>}<StatePanel close={closeState} mobile={mobile}/></>}</div>;
}
