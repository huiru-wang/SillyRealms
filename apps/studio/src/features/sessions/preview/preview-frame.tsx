import React,{Component,useState} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {SR,type SessionRunEvent,type StateEvent,type StateScope} from '@sillyrealms/sdk';
import {SessionRuntime} from '../../../../../../packages/sr-sdk/src/session-runtime';
import {StateRuntime} from '../../../../../../packages/sr-sdk/src/state-runtime';
import {AtomicContext} from '../../../../../../packages/sr-sdk/src/atomic-context';
import {StoryContext,type MessageMatch,type StoryConfiguration} from '../../../../../../packages/sr-sdk/src/story-context';
import {ComposedStoryPreview} from './ComposedStoryPreview';
import {previewRules,previewScenarios,previewStateDefinitions,type PreviewKind,type PreviewScenario,type PreviewSnapshot} from './fixtures';
import {isRecord,isRequestId,themeVariables,withinMessageLimit,type RequestMethod} from './protocol';
import '@sillyrealms/sdk/world-story.css';
import './preview-frame.css';

type Pending={resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:number};
const pending=new Map<number,Pending>();
let port:MessagePort|null=null;
let sequence=0;
let root:Root|null=null;
let session:SessionRuntime|null=null;
let state:StateRuntime|null=null;
let mounted=false;
let closed=false;
let currentFontSize=16;
const element=document.getElementById('root')!;

function post(value:unknown){
  if(!port||closed)return;
  if(!withinMessageLimit(value))throw Error('预览消息超过大小限制。');
  port.postMessage(value);
}
function command<T>(method:RequestMethod,data?:unknown):Promise<T>{
  if(!port||closed)return Promise.reject(Error('预览连接已关闭。'));
  if(pending.size>=128)return Promise.reject(Error('预览请求过于频繁。'));
  const id=++sequence;
  return new Promise<T>((resolve,reject)=>{
    const timer=window.setTimeout(()=>{
      pending.delete(id);reject(Error('预览请求超时，请重试。'));
    },15000);
    pending.set(id,{resolve:value=>resolve(value as T),reject,timer});
    try{post({type:'request',id,method,data});}
    catch(error){clearTimeout(timer);pending.delete(id);reject(error);}
  });
}
function applyAppearance(value:unknown){
  if(!isRecord(value)||!isRecord(value.colors))return;
  if(value.theme!=='light'&&value.theme!=='dark')return;
  if(typeof value.fontSize!=='number'||!Number.isFinite(value.fontSize))return;
  const nextSize=Math.max(13,Math.min(21,Math.round(value.fontSize)));
  if(nextSize!==currentFontSize)window.dispatchEvent(new Event('sr:font-size-will-change'));
  document.documentElement.dataset.theme=value.theme;
  for(const name of themeVariables){
    const color=value.colors[name];
    // Only inert color values for known tokens cross this boundary, never author CSS.
    if(typeof color==='string'&&color.length<=128&&!/[;{}]|url\(|var\(/i.test(color)&&CSS.supports('color',color)){
      element.style.setProperty(name,color);
    }
  }
  element.style.setProperty('--sr-story-font-size',nextSize+'px');
  if(nextSize!==currentFontSize){
    currentFontSize=nextSize;
    window.dispatchEvent(new Event('sr:font-size-changed'));
  }
}
function fatal(message:string){
  try{post({type:'ui-error',message});}catch{/* The local error remains visible if the port has failed. */}
}
class PreviewBoundary extends Component<{children:React.ReactNode},{error:boolean}>{
  state={error:false};
  static getDerivedStateFromError(){return {error:true};}
  componentDidCatch(){fatal('本地故事舞台暂时无法显示，请重新打开预览。');}
  render(){
    return this.state.error?<div className="preview-fatal" role="alert" data-preview-page-error>
      <h2>故事舞台暂时无法显示</h2><p>这是本地预览错误；重新打开样例即可恢复。</p>
    </div>:this.props.children;
  }
}
function Page({kind,scenario}:{kind:PreviewKind;scenario:PreviewScenario}){
  if(scenario==='page-error')throw Error('Local preview page failure fixture');
  const body=kind==='composed'?<ComposedStoryPreview/>:<SR.WorldStory/>;
  return scenario==='narrow'?<div className="preview-constrained">{body}</div>:body;
}
function mount(kind:PreviewKind,scenario:PreviewScenario){
  if(mounted)return;
  mounted=true;
  session=new SessionRuntime({
    send:text=>command('session.send',{text}),
    history:options=>command('session.history',options),
    setDraft:text=>{
      if(typeof text==='string'&&text.length<=100000)post({type:'set-draft',text});
    },
  });
  state=new StateRuntime({
    read:()=>command<PreviewSnapshot>('state.read'),
    write:updates=>command<Array<{path:string;scope:StateScope;success:boolean;message:string}>>('state.write',{updates}),
  });
  function Clue(){
    const [count,setCount]=useState(0);
    if(scenario==='component-error')throw Error('Local preview component failure fixture');
    return <div className="preview-message-clue" data-preview-clue>
      <div><strong>一条未解的线索</strong><small>本地消息组件样例</small></div>
      <button type="button" onClick={()=>setCount(value=>value+1)}>查看线索 · {count}</button>
    </div>;
  }
  Clue.srDisplay='block' as const;
  const config:StoryConfiguration={
    rules:previewRules,
    components:{Clue},
    state:previewStateDefinitions,
    ready:()=>post({type:'page-mounted'}),
    match:(text,role)=>command<{matches:MessageMatch[];warning:boolean}>('message.match',{text,role}),
  };
  // Start before render so both the Hook snapshot and the official panel exercise real reads.
  void state.refresh().catch(()=>{/* The official state panel provides its own visible retry. */});
  root=createRoot(element);
  root.render(<PreviewBoundary><AtomicContext.Provider value={{session,state}}>
    <StoryContext.Provider value={config}><Page kind={kind} scenario={scenario}/></StoryContext.Provider>
  </AtomicContext.Provider></PreviewBoundary>);
}
const runEvents=new Set(['run.created','run.phase','run.delta','run.snapshot','run.completed','run.failed','run.stopped']);
function receive(event:MessageEvent<unknown>){
  const value=event.data;
  if(closed)return;
  if(!isRecord(value)||!withinMessageLimit(value)){fatal('本地预览收到无效消息。');return;}
  if(value.type==='response'&&isRequestId(value.id)){
    const waiter=pending.get(value.id);
    if(!waiter)return;
    pending.delete(value.id);clearTimeout(waiter.timer);
    if(typeof value.error==='string')waiter.reject(Error(value.error));
    else waiter.resolve(value.result);
    return;
  }
  if(value.type==='appearance'){applyAppearance(value.appearance);return;}
  if(value.type==='init'){
    if(mounted||(value.kind!=='official'&&value.kind!=='composed')||!previewScenarios.includes(value.scenario as PreviewScenario))return;
    applyAppearance(value.appearance);
    mount(value.kind,value.scenario as PreviewScenario);
    return;
  }
  if(value.type==='event'&&isRecord(value.event)&&isRecord(value.event.data)){
    if(value.event.event==='state.changed')state?.accept(value.event as unknown as StateEvent);
    else if(typeof value.event.event==='string'&&runEvents.has(value.event.event))session?.accept(value.event as unknown as SessionRunEvent);
  }
}
const nonce=window.location.hash.slice(1);
function connect(event:MessageEvent<unknown>){
  if(closed||port||event.source!==window.parent||!isRecord(event.data))return;
  if(event.data.type!=='sr-preview-connect'||event.data.nonce!==nonce||event.ports.length!==1)return;
  port=event.ports[0]!;
  window.removeEventListener('message',connect);
  port.onmessage=receive;
  port.onmessageerror=()=>fatal('本地预览消息无法读取。');
  port.start();
  post({type:'ready-ack'});
}
if(/^[a-f0-9]{36}$/.test(nonce)&&window.parent!==window){
  window.addEventListener('message',connect);
  window.parent.postMessage({type:'sr-preview-ready',nonce},'*');
}else{
  root=createRoot(element);
  root.render(<div className="preview-fatal"><h2>请从 Studio 打开故事舞台预览</h2></div>);
}
window.addEventListener('pagehide',()=>{
  closed=true;
  window.removeEventListener('message',connect);
  for(const waiter of pending.values()){
    clearTimeout(waiter.timer);
    waiter.reject(Error('预览已关闭。'));
  }
  pending.clear();
  if(port){port.onmessage=null;port.onmessageerror=null;port.close();port=null;}
  root?.unmount();
},{once:true});
