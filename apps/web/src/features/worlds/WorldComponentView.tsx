import {errorKey} from '../../i18n/errors';
import {useTranslation} from 'react-i18next';
import {DEFAULT_LOCALE,isAppLocale} from '@sillyrealms/sdk/locale';
import {localOrigin} from '../../local-origin';
import {readAppearance} from '../../styles/theme';
import {Button} from '../../components/ui/Button';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {api} from '../../api';
import {randomId} from '../../random-id';
import {worldPreviewURL} from './preview-url';
import {worldAssetBaseUrl} from '../../world-assets';
import {worldStateQueries,readWorldState} from './world-component-protocol';
import {stageErrorMessage} from '../../../../../packages/sr-sdk/src/stage/feedback';
import type {PreviewModules} from './preview-cache';
import {PREVIEW_FOCUS_EVENT} from '../../components/ui/focus-navigation';
import {createPreviewDialogHost} from './preview-dialog';

type Props={worldId:string;entry:string;title:string;active:boolean;dialog?:boolean;load:(refresh?:boolean)=>Promise<PreviewModules>};

export function WorldComponentView(props:Props) {
  const [revision,setRevision]=useState(0);
  return <MountedWorldComponent key={revision} {...props} refresh={revision>0} retry={()=>setRevision(value=>value+1)}/>;
}
function MountedWorldComponent({worldId,entry,title,active,dialog=false,load,refresh,retry}:Props&{refresh:boolean;retry:()=>void}) {
  const {t,i18n}=useTranslation('stage');
  const locale=isAppLocale(i18n.resolvedLanguage)?i18n.resolvedLanguage:DEFAULT_LOCALE;
  const latest=useRef({t,locale});latest.current={t,locale};
  const notifyAppearance=useRef<(()=>void)|undefined>(undefined);
  useEffect(()=>{notifyAppearance.current?.();},[locale]);
  const frame=useRef<HTMLIFrameElement>(null),[error,setError]=useState(''),[loaded,setLoaded]=useState(false),[height,setHeight]=useState(1);
  const [source,setSource]=useState<string>(),onFrameLoad=useRef<(()=>void)|undefined>(undefined);
  const visible=useRef(active),dialogEnabled=useRef(dialog),notifyVisibility=useRef<(()=>void)|undefined>(undefined);
  const requestDialogFocus=useRef<((edge:unknown)=>void)|undefined>(undefined);
  useLayoutEffect(()=>{visible.current=active;dialogEnabled.current=dialog;notifyVisibility.current?.();},[active,dialog]);
  useLayoutEffect(()=>{
    const element=frame.current;
    const focus=(event:Event)=>requestDialogFocus.current?.((event as CustomEvent).detail?.edge);
    element?.addEventListener(PREVIEW_FOCUS_EVENT,focus);
    return()=>element?.removeEventListener(PREVIEW_FOCUS_EVENT,focus);
  },[source,error]);

  useEffect(()=>{
    const nonce=randomId();
    setSource(undefined);setLoaded(false);setHeight(1);setError('');
    let gone=false,port:MessagePort|undefined,connected=false,ready=false,compiled:PreviewModules|undefined;
    let expectedOrigin:string|undefined;
    const abort=new AbortController();
    const dialogKeyboard=createPreviewDialogHost({
      frame:()=>frame.current,enabled:()=>dialogEnabled.current,active:()=>visible.current,
      send:message=>{if(!gone&&ready)port?.postMessage(message);},
    });
    requestDialogFocus.current=dialogKeyboard.focus;
    const fail=(reason?:unknown)=>{if(gone)return;setError(errorKey(reason,'stage:preview.loadFailed'));gone=true;clearTimeout(timer);abort.abort();dialogKeyboard.dispose();port?.close();};
    const timer=setTimeout(fail,20000);
    onFrameLoad.current=()=>{
      if(gone||!expectedOrigin)return;
      // A document navigation revokes the bridge; only an explicit retry reconnects.
      if(connected){fail();return;}
      frame.current?.contentWindow?.postMessage({type:'sr-world-probe',nonce},expectedOrigin);
    };
    function appearance(){if(gone)return;port?.postMessage({type:'appearance',locale:latest.current.locale,...readAppearance()});}
    notifyAppearance.current=appearance;
    notifyVisibility.current=()=>{
      if(!gone&&ready){port?.postMessage({type:'visibility',active:visible.current});dialogKeyboard.sync();}
    };
    function render(){if(ready&&compiled){appearance();notifyVisibility.current?.();port?.postMessage({type:'render',entry,modules:compiled,assetBaseUrl:worldAssetBaseUrl(location.origin,worldId)});}}
    const listener=(event:MessageEvent)=>{
      if(gone||connected||!expectedOrigin||event.source!==frame.current?.contentWindow||event.origin!==expectedOrigin||event.data?.type!=='sr-world-ready'||event.data.nonce!==nonce)return;
      connected=true;const channel=new MessageChannel();port=channel.port1;
      port.onmessage=async({data})=>{
        if(gone||!data||typeof data!=='object')return;
        if(dialogKeyboard.receive(data))return;
        if(data.type==='ready'){ready=true;notifyVisibility.current?.();render();}
        else if(data.type==='mounted'){clearTimeout(timer);setLoaded(true);}
        else if(data.type==='ui-error')fail(data.message);
        else if(data.type==='resize'&&visible.current&&Number.isFinite(data.height)&&data.height>=0&&data.height<=100000)setHeight(Math.max(1,Math.ceil(data.height)));
        else if(data.type==='request'&&Number.isSafeInteger(data.id)){
          try {
            if(JSON.stringify(data).length>300000)throw Error('REQUEST_TOO_LARGE');
            const queries=worldStateQueries(data.method,data.data);
            const snapshot=await api<{item:Record<string,any>}>('v1/state/global/'+encodeURIComponent(worldId),{signal:abort.signal});
            if(!gone)port?.postMessage({type:'response',id:data.id,data:queries.map(query=>({...query,value:readWorldState(snapshot.item,query.path)}))});
          }catch(err){if(!gone)port?.postMessage({type:'response',id:data.id,error:errorKey(err,'stage:preview.readFailed')});}
        }
      };
      port.start();frame.current?.contentWindow?.postMessage({type:'sr-world-connect',nonce},expectedOrigin,[channel.port2]);
    };
    window.addEventListener('message',listener);
    const theme=new MutationObserver(appearance);theme.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','style','class']});
    void load(refresh).then(value=>{if(!gone){compiled=value;render();}}).catch(fail);
    try {
      const url=worldPreviewURL(import.meta.env.VITE_WORLD_PREVIEW_ORIGIN??localOrigin(location.origin, 5177),location.origin,nonce);
      expectedOrigin=url.origin;setSource(url.href);
    } catch(error) {fail(error);}
    return()=>{gone=true;clearTimeout(timer);abort.abort();theme.disconnect();dialogKeyboard.dispose();port?.close();requestDialogFocus.current=undefined;onFrameLoad.current=undefined;notifyVisibility.current=undefined;notifyAppearance.current=undefined;window.removeEventListener('message',listener);};
  },[worldId,entry,load,refresh]);
  if(error)return <div role="alert"><p>{stageErrorMessage(error,key=>t(key),key=>i18n.exists(key,{ns:'stage'}))}</p><Button variant="secondary" onClick={retry}>{t('common.retry')}</Button></div>;
  return <>{!loaded&&<p role="status">{t('preview.loading')}</p>}{source&&<iframe key={source} ref={frame} title={title} data-world-component={entry} src={source} sandbox="allow-scripts allow-same-origin" onLoad={()=>onFrameLoad.current?.()} style={{display:'block',width:'100%',height,border:0,visibility:loaded?'visible':'hidden'}}/>}</>;
}
