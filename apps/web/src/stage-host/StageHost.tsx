import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {errorKey} from '../i18n/errors';
import {useTranslation} from 'react-i18next';
import {DEFAULT_LOCALE,isAppLocale} from '@sillyrealms/sdk/locale';
import {readAppearance} from '../styles/theme';
import {randomId} from '../random-id';
import {stageURL} from '../stage-url';
import {bindComposerButtons, type HostedComposerButton} from './composer-buttons';
import {dispatchStageCommand} from './commands';
import {stageErrorMessage} from '../../../../packages/sr-sdk/src/stage/feedback';
import type {SessionEvent,StageCommand,StageSnapshot} from '../../../../packages/sr-sdk/src/stage-contract';
import styles from '../features/sessions/Sessions.module.css';

export type StageRender = {
  modules: {code: Record<string,string>; errors: Record<string,string>};
  main?: string | null; rules: unknown[]; state: unknown; assetBaseUrl: string | null; debug: boolean;
};
type Props = {
  config: unknown; render: StageRender; snapshot: StageSnapshot; command: StageCommand;
  subscribeEvents: (listener:(event:SessionEvent)=>void)=>()=>void;
  onComposerButtons: (buttons: HostedComposerButton[]) => void;
  fontSize: number; bottomInset: number; onNotice?: (message:string)=>void;
};
/** Only iframe and MessagePort lifetime live here. Session execution survives a frame remount. */
export function StageHost(props: Props){
  const {t,i18n}=useTranslation('stage');
  const locale=isAppLocale(i18n.resolvedLanguage)?i18n.resolvedLanguage:DEFAULT_LOCALE;
  const latest=useRef({...props,t,locale});latest.current={...props,t,locale};
  const displayError=(value:string)=>stageErrorMessage(value,key=>latest.current.t(key),key=>i18n.exists(key,{ns:'stage'}));
  const frame=useRef<HTMLIFrameElement>(null),port=useRef<MessagePort|null>(null);
  const [attempt,setAttempt]=useState(0),[error,setError]=useState(''),[mounted,setMounted]=useState(false);
  const [source,setSource]=useState<{url:string;origin:string;nonce:string}|null>(null);
  const onLoad=useRef<()=>void>(()=>{});
  const send=(value:unknown)=>{try{port.current?.postMessage(value);}catch{/* Navigation invalidates a port; the next handshake installs a fresh one. */}};
  const appearance=()=>send({type:'appearance',locale:latest.current.locale,fontSize:latest.current.fontSize,bottomInset:latest.current.bottomInset,...readAppearance()});
  useLayoutEffect(()=>{
    let disposed=false,connected=false,ready=false,timer:ReturnType<typeof setTimeout>|undefined;
    let sourceValue:{url:string;origin:string;nonce:string};
    setError('');setMounted(false);setSource(null);
    let buttons: ReturnType<typeof bindComposerButtons> | undefined;
    const close=()=>{buttons?.close();buttons=undefined;clearTimeout(timer);port.current?.close();port.current=null;connected=false;ready=false;};
    const fail=(message:string)=>{if(disposed)return;close();setMounted(false);setError(message);};
    try{const nonce=randomId(),url=stageURL(props.config,location.origin,nonce);sourceValue={url:url.href,origin:url.origin,nonce};}
    catch(reason){setError(errorKey(reason,'stage:host.invalidAddress'));return;}
    const publish=()=>{
      appearance();send({type:'snapshot',snapshot:latest.current.snapshot});
      send({type:'render',...latest.current.render});
    };
    const listener=(event:MessageEvent)=>{
      if(disposed||connected||event.source!==frame.current?.contentWindow||event.origin!==sourceValue.origin||
        event.data?.type!=='sr-ready'||event.data.nonce!==sourceValue.nonce)return;
      connected=true;const channel=new MessageChannel();port.current=channel.port1;
      buttons=bindComposerButtons(channel.port1,latest.current.onComposerButtons);
      channel.port1.onmessage=async({data})=>{
        if(disposed||port.current!==channel.port1||!data||typeof data!=='object')return;
        if(data.type==='ready-ack'){ready=true;publish();}
        else if(data.type==='page-mounted'){clearTimeout(timer);setMounted(true);}
        else if(data.type==='composer-buttons'&&ready)buttons?.receive(data);
        else if(data.type==='ui-error')fail(errorKey(data.message,'stage:host.componentFailed'));
        else if(data.type==='sdk-error'||data.type==='message-error')latest.current.onNotice?.(errorKey(data.message,'stage:host.processingFailed'));
        else if(data.type==='request'&&Number.isSafeInteger(data.id)&&data.id>0){
          try{
            if(new TextEncoder().encode(JSON.stringify(data)).byteLength>2*1024*1024)throw Error('stage:host.requestTooLarge');
            const result=await dispatchStageCommand(latest.current.command,data.method,data.data??{});
            if(!disposed&&port.current===channel.port1)channel.port1.postMessage({type:'response',id:data.id,data:result});
          }catch(reason){if(!disposed&&port.current===channel.port1)channel.port1.postMessage({type:'response',id:data.id,error:errorKey(reason,'stage:host.operationFailed')});}
        }
      };
      channel.port1.start();
      frame.current?.contentWindow?.postMessage({type:'sr-connect',nonce:sourceValue.nonce},sourceValue.origin,[channel.port2]);
    };
    onLoad.current=()=>{
      if(disposed)return;close();setMounted(false);
      timer=setTimeout(()=>fail('stage:host.connectionTimeout'),15000);
      frame.current?.contentWindow?.postMessage({type:'sr-probe',nonce:sourceValue.nonce},sourceValue.origin);
    };
    window.addEventListener('message',listener);
    const unsubscribe=props.subscribeEvents(event=>{if(ready)send({type:'event',event});});
    const observer=new MutationObserver(appearance);observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','data-theme-id','style','class']});
    timer=setTimeout(()=>fail('stage:host.loadTimeout'),15000);setSource(sourceValue);
    return()=>{disposed=true;close();unsubscribe();observer.disconnect();onLoad.current=()=>{};window.removeEventListener('message',listener);};
  },[props.config,props.subscribeEvents,attempt]);
  useEffect(()=>{
    const id=requestAnimationFrame(()=>send({type:'snapshot',snapshot:props.snapshot}));
    return()=>cancelAnimationFrame(id);
  },[props.snapshot]);
  useEffect(()=>{appearance();},[props.fontSize,props.bottomInset,locale]);
  useEffect(()=>{send({type:'render',...props.render});},[props.render]);
  if(error)return <div className="stage-error" role="alert"><h2>{t('host.unavailable')}</h2><p>{displayError(error)}</p><button type="button" onClick={()=>setAttempt(value=>value+1)}>{t('host.reload')}</button></div>;
  return <>{!mounted&&<p className="stage-loading" role="status">{t('host.loading')}</p>}{source&&<iframe ref={frame} key={source.nonce} className={styles.preview} title={t('host.title')} sandbox="allow-scripts allow-same-origin" src={source.url} onLoad={()=>onLoad.current()}/>}</>;
}
