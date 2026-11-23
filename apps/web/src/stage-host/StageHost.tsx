import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {readAppearance} from '../styles/theme';
import {randomId} from '../random-id';
import {stageURL} from '../stage-url';
import {bindComposerButtons, type HostedComposerButton} from './composer-buttons';
import {dispatchStageCommand} from './commands';
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
  const latest=useRef(props);latest.current=props;
  const frame=useRef<HTMLIFrameElement>(null),port=useRef<MessagePort|null>(null);
  const [attempt,setAttempt]=useState(0),[error,setError]=useState(''),[mounted,setMounted]=useState(false);
  const [source,setSource]=useState<{url:string;origin:string;nonce:string}|null>(null);
  const onLoad=useRef<()=>void>(()=>{});
  const send=(value:unknown)=>{try{port.current?.postMessage(value);}catch{/* Navigation invalidates a port; the next handshake installs a fresh one. */}};
  const appearance=()=>send({type:'appearance',fontSize:latest.current.fontSize,bottomInset:latest.current.bottomInset,...readAppearance()});
  useLayoutEffect(()=>{
    let disposed=false,connected=false,ready=false,timer:ReturnType<typeof setTimeout>|undefined;
    let sourceValue:{url:string;origin:string;nonce:string};
    setError('');setMounted(false);setSource(null);
    let buttons: ReturnType<typeof bindComposerButtons> | undefined;
    const close=()=>{buttons?.close();buttons=undefined;clearTimeout(timer);port.current?.close();port.current=null;connected=false;ready=false;};
    const fail=(message:string)=>{if(disposed)return;close();setMounted(false);setError(message);};
    try{const nonce=randomId(),url=stageURL(props.config,location.origin,nonce);sourceValue={url:url.href,origin:url.origin,nonce};}
    catch(reason){setError(reason instanceof Error?reason.message:'舞台地址无效');return;}
    const publish=()=>{
      send({type:'render',...latest.current.render});
      send({type:'snapshot',snapshot:latest.current.snapshot});appearance();
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
        else if(data.type==='ui-error')fail(typeof data.message==='string'?data.message:'世界组件运行失败');
        else if(data.type==='sdk-error'||data.type==='message-error')latest.current.onNotice?.(String(data.message??'组件处理失败'));
        else if(data.type==='request'&&Number.isSafeInteger(data.id)&&data.id>0){
          try{
            if(new TextEncoder().encode(JSON.stringify(data)).byteLength>2*1024*1024)throw Error('舞台请求过大');
            const result=await dispatchStageCommand(latest.current.command,data.method,data.data??{});
            if(!disposed&&port.current===channel.port1)channel.port1.postMessage({type:'response',id:data.id,data:result});
          }catch(reason){if(!disposed&&port.current===channel.port1)channel.port1.postMessage({type:'response',id:data.id,error:reason instanceof Error?reason.message:'舞台操作失败'});}
        }
      };
      channel.port1.start();
      frame.current?.contentWindow?.postMessage({type:'sr-connect',nonce:sourceValue.nonce},sourceValue.origin,[channel.port2]);
    };
    onLoad.current=()=>{
      if(disposed)return;close();setMounted(false);
      timer=setTimeout(()=>fail('故事舞台连接超时，请检查独立舞台服务。'),15000);
      frame.current?.contentWindow?.postMessage({type:'sr-probe',nonce:sourceValue.nonce},sourceValue.origin);
    };
    window.addEventListener('message',listener);
    const unsubscribe=props.subscribeEvents(event=>{if(ready)send({type:'event',event});});
    const observer=new MutationObserver(appearance);observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','data-theme-id','style','class']});
    timer=setTimeout(()=>fail('故事舞台加载超时，请检查独立舞台服务。'),15000);setSource(sourceValue);
    return()=>{disposed=true;close();unsubscribe();observer.disconnect();onLoad.current=()=>{};window.removeEventListener('message',listener);};
  },[props.config,props.subscribeEvents,attempt]);
  useEffect(()=>{
    const id=requestAnimationFrame(()=>send({type:'snapshot',snapshot:props.snapshot}));
    return()=>cancelAnimationFrame(id);
  },[props.snapshot]);
  useEffect(()=>{appearance();},[props.fontSize,props.bottomInset]);
  useEffect(()=>{send({type:'render',...props.render});},[props.render]);
  if(error)return <div className="stage-error" role="alert"><h2>故事舞台暂时不可用</h2><p>{error}</p><button type="button" onClick={()=>setAttempt(value=>value+1)}>重新加载舞台</button></div>;
  return <>{!mounted&&<p className="stage-loading" role="status">正在加载故事舞台…</p>}{source&&<iframe ref={frame} key={source.nonce} className={styles.preview} title="会话故事舞台" sandbox="allow-scripts allow-same-origin" src={source.url} onLoad={()=>onLoad.current()}/>}</>;
}
