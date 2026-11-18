import {applyAppearance,applyTheme,builtinTheme} from './styles/theme';
import './styles/tokens.css';
import './styles/themes.css';
applyTheme(builtinTheme('dark'));
import React from 'react';
import * as ReactDOMClient from 'react-dom/client';
import * as JSXRuntime from 'react/jsx-runtime';
import '@tailwindcss/browser';
import {createModuleLoader} from '../../../packages/sr-ui-compiler/src/loader';
import {WorldStateContext,WorldDocumentContent,useSRWorldStateAPI,type SRWorldStateAPI} from '../../../packages/sr-sdk/src/world-state';
import {RichText,SRAssetProvider,useSRAssetUrl} from '@sillyrealms/sdk';
import './world-component-frame.css';
let port:MessagePort|undefined,sequence=0;
const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
function read(entries:Array<{path:string;scope?:'global'}>):Promise<any> {
  if(!port)return Promise.reject(Error('World state bridge unavailable'));
  const id=++sequence;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(Error('World state request timed out'));},15000);
    pending.set(id,{resolve,reject,timer});port!.postMessage({type:'request',id,method:'world.state.read',data:{entries}});
  });
}
const state:SRWorldStateAPI=Object.freeze({getState:async(path:string,scope?:'global')=>(await read([{path,scope}]))[0]?.value,batchGetState:read});
// No session runtime, subscriptions, mutable state API, card object, or raw transport is exported.
const sdk=Object.freeze({useSRWorldStateAPI,useSRStateAPI:useSRWorldStateAPI,WorldDocumentContent,RichText,useSRAssetUrl});
class Boundary extends React.Component<{children:React.ReactNode},{failed:boolean}> {
  state={failed:false};static getDerivedStateFromError(){return {failed:true};}
  componentDidCatch(error:Error){port?.postMessage({type:'ui-error',message:error.message});}
  render(){return this.state.failed?null:this.props.children;}
}
const rootElement=document.getElementById('root')!,root=ReactDOMClient.createRoot(rootElement),nonce=location.hash.slice(1);
const hostOrigin=(()=>{
  try {
    const raw=new URLSearchParams(location.search).get('hostOrigin'),url=new URL(raw??'');
    const allowed=import.meta.env.VITE_STUDIO_ORIGIN??'http://127.0.0.1:5176';
    return raw===allowed&&raw===url.origin&&['http:','https:'].includes(url.protocol)&&url.origin!==location.origin?url.origin:null;
  }catch{return null;}
})();
if(!hostOrigin||window.parent===window)root.render(<p>此内容尚未连接，请从 SR 世界卡详情打开。</p>);
let lastHeight=0;
const resize=new ResizeObserver(()=>{const height=Math.ceil(rootElement.getBoundingClientRect().height);if(height!==lastHeight){lastHeight=height;port?.postMessage({type:'resize',height});}});
resize.observe(rootElement);
window.addEventListener('message',event=>{
  if(!hostOrigin||window.parent===window||event.source!==window.parent||event.origin!==hostOrigin||event.data?.nonce!==nonce)return;
  if(event.data.type==='sr-world-probe'&&!port){window.parent.postMessage({type:'sr-world-ready',nonce},hostOrigin);return;}
  if(port||event.data.type!=='sr-world-connect'||!event.ports[0])return;
  port=event.ports[0];
  port.onmessage=({data})=>{
    if(!data||typeof data!=='object')return;
    if(data.type==='response'){
      const request=pending.get(data.id);if(!request)return;clearTimeout(request.timer);pending.delete(data.id);
      if(data.error)request.reject(Error(data.error));else request.resolve(data.data);
    } else if(data.type==='appearance') {
      applyAppearance(data);
    } else if(data.type==='render') {
      try {
        const load=createModuleLoader(data.modules.code,data.modules.errors,{'react':React,'react-dom/client':ReactDOMClient,'react/jsx-runtime':JSXRuntime,'@sillyrealms/sdk':sdk},(source,module,require)=>new Function('module','exports','require','React',source)(module,module.exports,require,React));
        const Component=load(data.entry);
        function Mounted(){React.useEffect(()=>{port?.postMessage({type:'mounted'});},[]);return <Component/>;}
        root.render(<Boundary><SRAssetProvider baseUrl={data.assetBaseUrl??null}><WorldStateContext.Provider value={state}><Mounted/></WorldStateContext.Provider></SRAssetProvider></Boundary>);
      }catch(error){port?.postMessage({type:'ui-error',message:error instanceof Error?error.message:String(error)});}
    }
  };
  port.start();port.postMessage({type:'ready'});
});
window.addEventListener('pagehide',()=>{resize.disconnect();for(const request of pending.values()){clearTimeout(request.timer);request.reject(Error('Component closed'));}pending.clear();port?.close();});
window.addEventListener('error',event=>port?.postMessage({type:'ui-error',message:event.message||'组件运行错误'}));
window.addEventListener('unhandledrejection',event=>port?.postMessage({type:'ui-error',message:event.reason instanceof Error?event.reason.message:'组件发生未处理的异步错误'}));
