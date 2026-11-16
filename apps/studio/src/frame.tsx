import React from 'react';
import {createModuleLoader} from '../../../packages/sr-ui-compiler/src/loader';
import '@tailwindcss/browser';
import * as ReactDOMClient from 'react-dom/client';
import * as JSXRuntime from 'react/jsx-runtime';
import * as SDK from '@sillyrealms/sdk';
import { AtomicContext } from '../../../packages/sr-sdk/src/atomic-context';
import { StateRuntime } from '../../../packages/sr-sdk/src/state-runtime';
import { SessionRuntime } from '../../../packages/sr-sdk/src/session-runtime';
import type { StateEvent } from '../../../packages/sr-sdk/src/state-contract';
import type { SessionRunEvent } from '../../../packages/sr-sdk/src/run-contract';
import {StoryContext,type MessageComponent} from '../../../packages/sr-sdk/src/story-context';
import './frame.css';
import '@sillyrealms/sdk/world-story.css';

let port:MessagePort;
let connected=false;
let sequence=0;
const pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>();
function command<T>(method:string,data:unknown={}):Promise<T> {
  if(!connected)return Promise.reject(Error('会话页面尚未连接'));
  const id=++sequence;
  return new Promise((resolve,reject)=>{pending.set(id,{resolve:resolve as (value:unknown)=>void,reject});port.postMessage({type:'request',id,method,data});});
}
const state=new StateRuntime({read:()=>command('state.read'),write:updates=>command('state.write',{updates})});
const session=new SessionRuntime({send:text=>command('session.send',{text}),history:options=>command('session.history',options),setDraft:text=>port?.postMessage({type:'set-draft',text})});
class Boundary extends React.Component<{children:React.ReactNode},{error:boolean}>{
  state={error:false};
  static getDerivedStateFromError(){return {error:true};}
  componentDidCatch(error:Error){port.postMessage({type:'ui-error',message:error.message});}
  render(){return this.state.error?<p>页面出现错误。</p>:this.props.children;}
}
const PendingOfficial=SDK.SR.WorldStory;
function Mounted({component:Component}:{component:React.ComponentType}){
  React.useEffect(()=>{port.postMessage({type:'page-mounted'});},[]);
  return <Component/>;
}
const nonce=location.hash.slice(1);
const hostOrigin=(()=>{
  try {
    const raw=new URLSearchParams(location.search).get('hostOrigin'),url=new URL(raw??'');
    return raw===url.origin&&['http:','https:'].includes(url.protocol)&&url.origin!==location.origin?url.origin:null;
  }catch{return null;}
})();
const root=ReactDOMClient.createRoot(document.getElementById('root')!);
function disconnect(){connected=false;for(const request of pending.values())request.reject(Error('会话页面已断开'));pending.clear();port?.close();}
if(!hostOrigin||window.parent===window)root.render(<p>此故事舞台尚未连接，请从 SR 会话页面打开。</p>);
window.addEventListener('message',function receive(event){
  if(!hostOrigin||window.parent===window||event.source!==window.parent||event.origin!==hostOrigin||event.data?.nonce!==nonce)return;
  if(event.data.type==='sr-probe'){
    disconnect();window.parent.postMessage({type:'sr-ready',nonce},hostOrigin);return;
  }
  if(event.data.type!=='sr-connect'||connected||!event.ports[0])return;
  port=event.ports[0];connected=true;
  port.onmessage=message=>{
    const payload=message.data;
    if(payload.type==='response'){
      const request=pending.get(payload.id);pending.delete(payload.id);
      if(request)(payload.error?request.reject(Error(payload.error)):request.resolve(payload.data));
    } else if(payload.type==='theme') {
      document.documentElement.dataset.theme=payload.value==='dark'?'dark':'light';
    } else if(payload.type==='appearance') {
      if(Number.isFinite(payload.bottomInset)&&payload.bottomInset>=0&&payload.bottomInset<=800)document.documentElement.style.setProperty('--sr-story-bottom-inset',payload.bottomInset+'px');
      for(const [name,value] of Object.entries(payload.colors??{})){if(/^--sr-story-(bg|surface|text|muted|border|accent|focus)$/.test(name)&&typeof value==='string'&&CSS.supports('color',value))document.documentElement.style.setProperty(name,value);}
      const size=payload.fontSize;
      if(Number.isInteger(size)&&size>=13&&size<=21){
        window.dispatchEvent(new Event('sr:font-size-will-change'));
        document.documentElement.style.setProperty('--sr-story-font-size',size+'px');
        window.dispatchEvent(new Event('sr:font-size-changed'));
      }
    } else if(payload.type==='connected') {
      void state.refresh().catch(error=>port.postMessage({type:'sdk-error',message:error instanceof Error?error.message:'状态读取失败'}));
    } else if(payload.type==='event') {
      if(payload.event?.event==='state.changed')state.accept(payload.event as StateEvent);
      else if(['action_suggestions.changed','session.connection'].includes(payload.event?.event)||String(payload.event?.event??'').startsWith('run.'))session.accept(payload.event as SessionRunEvent);
    } else if(payload.type==='render') {
      try {
        let Component:React.ComponentType=PendingOfficial;
        const code=payload.modules?.code??{}, errors=payload.modules?.errors??{};
        const load=createModuleLoader(code,errors,{'react':React,'react-dom/client':ReactDOMClient,'react/jsx-runtime':JSXRuntime,'@sillyrealms/sdk':SDK},
          (source,module,require)=>new Function('module','exports','require','React',source)(module,module.exports,require,React));
        const custom=typeof payload.main==='string'&&(Object.hasOwn(code,payload.main)||Object.hasOwn(errors,payload.main));
        if(custom)Component=load(payload.main);
        const components:Record<string,MessageComponent>=Object.create(null);
        const referenced=new Set<string>((payload.rules??[]).filter((rule:any)=>rule.replacement?.type==='component').map((rule:any)=>rule.replacement.component));
        for(const id of referenced){
          let resolved=false,component:MessageComponent|undefined;
          Object.defineProperty(components,id,{enumerable:true,get(){
            if(resolved)return component;resolved=true;
            try {
              const candidate=load(id) as MessageComponent;
              if(candidate.srDisplay!==undefined&&candidate.srDisplay!=='inline'&&candidate.srDisplay!=='block')throw Error('消息组件显示类型无效');
              component=candidate;
            }catch(error){port.postMessage({type:'message-error',component:id,message:error instanceof Error?error.message:String(error)});}
            return component;
          }});
        }
        root.render(<Boundary key={payload.main??'official'}><SDK.SRAssetProvider baseUrl={payload.assetBaseUrl??null}><AtomicContext.Provider value={{session,state}}><StoryContext.Provider value={{components,rules:payload.rules??[],state:payload.state??{},ready:()=>port.postMessage({type:'page-mounted'}),match:(text,role)=>command('message.match',{text,role})}}>{custom?<Mounted component={Component}/>:<Component/>}</StoryContext.Provider></AtomicContext.Provider></SDK.SRAssetProvider></Boundary>);
      } catch(error){port.postMessage({type:'ui-error',message:error instanceof Error?error.message:String(error)});}
    }
  };
  port.start();port.postMessage({type:'ready-ack'});
});
window.addEventListener('pagehide',disconnect);
window.addEventListener('error',event=>port?.postMessage({type:'ui-error',message:event.message||'页面运行错误'}));
window.addEventListener('unhandledrejection',()=>port?.postMessage({type:'ui-error',message:'页面发生未处理的异步错误'}));
