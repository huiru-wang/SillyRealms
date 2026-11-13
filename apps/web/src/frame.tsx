import React from 'react';
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

let port:MessagePort;
let sequence=0;
const pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>();
function command<T>(method:string,data:unknown={}):Promise<T> {
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
const root=ReactDOMClient.createRoot(document.getElementById('root')!);
window.addEventListener('message',function receive(event){
  if(event.source!==window.parent||event.data?.type!=='sr-connect'||event.data.nonce!==nonce||!event.ports[0])return;
  window.removeEventListener('message',receive);port=event.ports[0];
  port.onmessage=message=>{
    const payload=message.data;
    if(payload.type==='response'){
      const request=pending.get(payload.id);pending.delete(payload.id);
      if(request)(payload.error?request.reject(Error(payload.error)):request.resolve(payload.data));
    } else if(payload.type==='theme') {
      document.documentElement.dataset.theme=payload.value==='dark'?'dark':'light';
    } else if(payload.type==='appearance') {
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
      else if(String(payload.event?.event??'').startsWith('run.'))session.accept(payload.event as SessionRunEvent);
    } else if(payload.type==='render') {
      try {
        let Component:React.ComponentType=PendingOfficial;
        const require=(name:string)=>name==='react'?React:name==='react-dom/client'?ReactDOMClient:name==='react/jsx-runtime'?JSXRuntime:name==='@sr/sdk'?SDK:(()=>{throw Error('禁止的依赖');})();
        if(payload.code){
          const module={exports:{} as {default?:React.ComponentType}};
          new Function('module','exports','require','React',payload.code)(module,module.exports,require,React);
          if(typeof module.exports.default!=='function')throw Error('默认导出必须是 React 函数组件');
          Component=module.exports.default;
        }
        const components:Record<string,MessageComponent>=Object.create(null);
        if(payload.messageCode){
          try {
            const module={exports:{} as {default?:unknown}};
            new Function('module','exports','require','React',payload.messageCode)(module,module.exports,require,React);
            const values=module.exports.default;
            if(!values||typeof values!=='object'||Array.isArray(values))throw Error('消息组件导出无效');
            for(const [name,value] of Object.entries(values)){
              const component=value as {$$typeof?:symbol;srDisplay?:unknown}|null;
              const exotic=component&&typeof component==='object'&&[Symbol.for('react.memo'),Symbol.for('react.forward_ref')].includes(component.$$typeof!);
              if((typeof value!=='function'&&!exotic)||(component?.srDisplay!==undefined&&component.srDisplay!=='inline'&&component.srDisplay!=='block'))throw Error('消息组件无效');
              components[name]=value as MessageComponent;
            }
          } catch {for(const name of Object.keys(components))delete components[name];port.postMessage({type:'message-error'});}
        }
        root.render(<Boundary key={payload.code??'official'}><AtomicContext.Provider value={{session,state}}><StoryContext.Provider value={{components,rules:payload.rules??[],state:payload.state??{},ready:()=>port.postMessage({type:'page-mounted'}),match:(text,role)=>command('message.match',{text,role})}}>{payload.code?<Mounted component={Component}/>:<Component/>}</StoryContext.Provider></AtomicContext.Provider></Boundary>);
      } catch(error){port.postMessage({type:'ui-error',message:error instanceof Error?error.message:String(error)});}
    }
  };
  port.start();port.postMessage({type:'ready-ack'});
});
window.addEventListener('pagehide',()=>{for(const request of pending.values())request.reject(Error('会话页面已关闭'));pending.clear();port?.close();});
window.addEventListener('error',event=>port?.postMessage({type:'ui-error',message:event.message||'页面运行错误'}));
window.addEventListener('unhandledrejection',()=>port?.postMessage({type:'ui-error',message:'页面发生未处理的异步错误'}));
window.parent.postMessage({type:'sr-ready',nonce},'*');
