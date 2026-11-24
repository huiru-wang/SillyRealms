import {localOrigin} from './local-origin';
import {FrameLocale,stageHostOrigin} from './stage-frame-protocol';
import {applyAppearance,applyTheme,builtinTheme} from './styles/theme';
import './styles/tokens.css';
import './styles/themes.css';
applyTheme(builtinTheme('dark'));
import React from 'react';
import {I18nextProvider,useTranslation} from 'react-i18next';
import {i18n} from './i18n/instance';
import * as ReactDOMClient from 'react-dom/client';
import * as JSXRuntime from 'react/jsx-runtime';
import '@tailwindcss/browser';
import {createModuleLoader} from '../../../packages/sr-ui-compiler/src/loader';
import {WorldStateContext,WorldDocumentContent,useSRWorldStateAPI,type SRWorldStateAPI} from '../../../packages/sr-sdk/src/world-state';
import {RichText,SRAssetProvider,useSRAssetUrl} from '@sillyrealms/sdk';
import './world-component-frame.css';
import {createPreviewActivity} from './features/worlds/preview-activity';
let port:MessagePort|undefined,sequence=0,locale:FrameLocale|undefined;
const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
function read(entries:Array<{path:string;scope?:'global'}>):Promise<any> {
  if(!port)return Promise.reject(Error('stage:preview.readUnavailable'));
  const id=++sequence;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(Error('stage:preview.readTimeout'));},15000);
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
const hostOrigin = stageHostOrigin(location.search, location.origin, import.meta.env.VITE_WEB_ORIGIN ?? localOrigin(location.origin, 5176));
function Disconnected(){const {t}=useTranslation('stage');return <p>{t('preview.notConnected')}</p>;}
if(!hostOrigin||window.parent===window)root.render(<I18nextProvider i18n={i18n}><Disconnected/></I18nextProvider>);
let lastHeight=0;
const activity=createPreviewActivity(document);
function reportHeight(force=false){
  if(!activity.active)return;
  const height=Math.ceil(rootElement.getBoundingClientRect().height);
  if(force||height!==lastHeight){lastHeight=height;port?.postMessage({type:'resize',height});}
}
const resize=new ResizeObserver(()=>reportHeight());
resize.observe(rootElement);
window.addEventListener('message',event=>{
  if(!hostOrigin||window.parent===window||event.source!==window.parent||event.origin!==hostOrigin||event.data?.nonce!==nonce)return;
  if(event.data.type==='sr-world-probe'&&!port){window.parent.postMessage({type:'sr-world-ready',nonce},hostOrigin);return;}
  if(port||event.data.type!=='sr-world-connect'||!event.ports[0])return;
  const channel=event.ports[0];port=channel;
  const currentLocale=new FrameLocale(async value=>{
    if(i18n.resolvedLanguage!==value)await i18n.changeLanguage(value);
    if(port===channel)document.documentElement.lang=value;
  });
  locale=currentLocale;
  port.onmessage=({data})=>{
    if(!data||typeof data!=='object')return;
    if(data.type==='response'){
      const request=pending.get(data.id);if(!request)return;clearTimeout(request.timer);pending.delete(data.id);
      if(data.error)request.reject(Error(data.error));else request.resolve(data.data);
    } else if(data.type==='appearance') {
      applyAppearance(data);
      void currentLocale.receive(data.locale).catch(error=>{if(port===channel)channel.postMessage({type:'ui-error',message:error instanceof Error?error.message:String(error)});});
    } else if(data.type==='visibility'&&typeof data.active==='boolean') {
      activity.setActive(data.active);
      if(data.active)requestAnimationFrame(()=>reportHeight(true));
    } else if(data.type==='render') {
      currentLocale.render(()=>{try {
        const load=createModuleLoader(data.modules.code,data.modules.errors,{'react':React,'react-dom/client':ReactDOMClient,'react/jsx-runtime':JSXRuntime,'@sillyrealms/sdk':sdk},(source,module,require)=>new Function('module','exports','require','React',source)(module,module.exports,require,React));
        const Component=load(data.entry);
        function Mounted(){React.useEffect(()=>{port?.postMessage({type:'mounted'});},[]);return <Component/>;}
        root.render(<I18nextProvider i18n={i18n}><Boundary><SRAssetProvider baseUrl={data.assetBaseUrl??null}><WorldStateContext.Provider value={state}><Mounted/></WorldStateContext.Provider></SRAssetProvider></Boundary></I18nextProvider>);
      }catch(error){port?.postMessage({type:'ui-error',message:error instanceof Error?error.message:String(error)});}});
    }
  };
  port.start();port.postMessage({type:'ready'});
});
window.addEventListener('pagehide',()=>{locale?.close();activity.dispose();resize.disconnect();for(const request of pending.values()){clearTimeout(request.timer);request.reject(Error('stage:preview.closed'));}pending.clear();port?.close();});
window.addEventListener('error',event=>port?.postMessage({type:'ui-error',message:event.message||'stage:preview.runtimeError'}));
window.addEventListener('unhandledrejection',event=>port?.postMessage({type:'ui-error',message:event.reason instanceof Error?event.reason.message:'stage:preview.unhandledError'}));
