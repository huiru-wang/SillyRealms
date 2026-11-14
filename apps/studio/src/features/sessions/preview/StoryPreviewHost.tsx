import {forwardRef,useEffect,useImperativeHandle,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {readPreviewScenario,type PreviewKind} from './fixtures';
import {PreviewTransport} from './preview-transport';
import {isRecord,isRequestId,requestMethods,themeVariables,withinMessageLimit,type PreviewAppearance,type RequestMethod} from './protocol';

export type PreviewStatus = {
  ready:boolean;
  active:boolean;
  phase:'preparing'|'narrative'|'extensions'|null;
  error:string|null;
};
export type StoryPreviewHandle = {
  send(text:string):Promise<{runId:string;requestId:string}>;
  stop():void;
};
type Props = {
  sessionId:string;
  kind:PreviewKind;
  fontSize:number;
  onSetDraft:(text:string)=>void;
  onStatusChange:(value:PreviewStatus)=>void;
  className?:string;
};
const initialStatus:PreviewStatus={ready:false,active:false,phase:null,error:null};
const sourceVariables=['--canvas','--surface','--text','--text-muted','--stroke','--accent','--focus'];
const fallbackColors=['#1c1a24','#282530','#f6f3fa','#9993a4','#3b3643','#ad89d0','#c6a5e9'];

function createNonce(){
  return Array.from(crypto.getRandomValues(new Uint8Array(18)),value=>value.toString(16).padStart(2,'0')).join('');
}
function appearance(fontSize:number):PreviewAppearance{
  const root=document.documentElement;
  const style=getComputedStyle(root);
  const colors=Object.fromEntries(themeVariables.map((name,index)=>[
    name,style.getPropertyValue(sourceVariables[index]!).trim()||fallbackColors[index]!,
  ])) as PreviewAppearance['colors'];
  return {theme:root.dataset.theme==='light'?'light':'dark',fontSize:Math.max(13,Math.min(21,Math.round(fontSize))),colors};
}
function sameStatus(a:PreviewStatus,b:PreviewStatus){
  return a.ready===b.ready&&a.active===b.active&&a.phase===b.phase&&a.error===b.error;
}

export const StoryPreviewHost=forwardRef<StoryPreviewHandle,Props>(function StoryPreviewHost(props,ref){
  const {sessionId,kind,fontSize,className}=props;
  const callbacks=useRef(props);
  callbacks.current=props;
  const iframe=useRef<HTMLIFrameElement>(null);
  const statusRef=useRef(initialStatus);
  const [status,setStatus]=useState(initialStatus);
  const [frameNonce,setFrameNonce]=useState<string|null>(null);
  const transportRef=useRef<PreviewTransport|null>(null);
  const postRef=useRef<((data:unknown)=>void)|null>(null);
  const sendRef=useRef<StoryPreviewHandle['send']>(async()=>{throw Error('故事舞台尚未就绪，请稍候。');});
  const scenario=useMemo(()=>readPreviewScenario(window.location.search),[sessionId,kind]);

  useImperativeHandle(ref,()=>({
    send:text=>sendRef.current(text),
    stop:()=>transportRef.current?.stop(),
  }),[]);

  useLayoutEffect(()=>{
    const nonce=createNonce();
    let live=true;
    let port:MessagePort|null=null;
    let connected=false;
    let initialized=false;
    const pending=new Set<number>();
    const update=(change:Partial<PreviewStatus>)=>{
      if(!live)return;
      const value={...statusRef.current,...change};
      if(sameStatus(value,statusRef.current))return;
      statusRef.current=value;
      setStatus(value);
      callbacks.current.onStatusChange(value);
    };
    // A new sample has a new channel and cannot inherit an old ready/active state.
    update(initialStatus);
    const fail=(message:string)=>{
      if(!live)return;
      transport.stop();
      update({ready:false,error:message});
    };
    const post=(data:unknown)=>{
      if(!live||!port)return;
      if(!withinMessageLimit(data)){fail('预览消息超过大小限制。');return;}
      port.postMessage(data);
    };
    postRef.current=post;
    const transport=new PreviewTransport(sessionId,kind,scenario,
      event=>post({type:'event',event}),
      activity=>update(activity),
    );
    transportRef.current=transport;
    const send:StoryPreviewHandle['send']=async text=>{
      if(!live||!statusRef.current.ready||statusRef.current.error)throw Error('故事舞台尚未就绪，请稍候或重新打开。');
      // All send paths share this transport and its one-active-run guard.
      return transport.send(text);
    };
    sendRef.current=send;
    const invoke=async(method:RequestMethod,data:unknown)=>{
      const input=isRecord(data)?data:{};
      switch(method){
        case 'session.history': {
          if(data!==undefined&&!isRecord(data))throw Error('无效的历史请求');
          if(input.cursor!==undefined&&typeof input.cursor!=='string')throw Error('无效的历史游标');
          if(input.limit!==undefined&&typeof input.limit!=='number')throw Error('无效的历史分页大小');
          return transport.history({cursor:input.cursor as string|undefined,limit:input.limit as number|undefined});
        }
        case 'session.send':
          if(typeof input.text!=='string')throw Error('无效的发送内容');
          return send(input.text);
        case 'state.read':return transport.readState();
        case 'state.write':throw Error('本地预览不支持 state.write；状态仅由确定性样例事件更新。');
        case 'message.match':
          if(typeof input.text!=='string'||(input.role!=='user'&&input.role!=='assistant'))throw Error('无效的消息匹配请求');
          return transport.match(input.text,input.role);
      }
    };
    const handshakeTimer=window.setTimeout(()=>{
      if(!initialized)fail('故事舞台连接失败，请重新打开预览。');
    },10000);
    const handlePort=(event:MessageEvent<unknown>)=>{
      if(!live)return;
      const value=event.data;
      if(!withinMessageLimit(value)||!isRecord(value)){fail('预览收到无效消息。');return;}
      if(value.type==='ready-ack'){
        if(initialized)return;
        initialized=true;
        clearTimeout(handshakeTimer);
        post({type:'init',kind,scenario,appearance:appearance(callbacks.current.fontSize)});
        return;
      }
      if(!initialized)return;
      if(value.type==='page-mounted'){
        if(!statusRef.current.error)update({ready:true});
        return;
      }
      if(value.type==='set-draft'){
        if(typeof value.text==='string'&&value.text.length<=100000)callbacks.current.onSetDraft(value.text);
        return;
      }
      if(value.type==='ui-error'){
        fail(typeof value.message==='string'?value.message.slice(0,300):'故事舞台暂时无法显示。');
        return;
      }
      if(value.type!=='request'||!isRequestId(value.id))return;
      const id=value.id;
      if(pending.has(id)||pending.size>=128){post({type:'response',id,error:'预览请求过于频繁。'});return;}
      if(typeof value.method!=='string'||!requestMethods.includes(value.method as RequestMethod)){
        post({type:'response',id,error:'预览不支持此命令。'});return;
      }
      pending.add(id);
      void invoke(value.method as RequestMethod,value.data).then(
        result=>{if(live)post({type:'response',id,result});},
        error=>{if(live)post({type:'response',id,error:error instanceof Error?error.message:'预览请求失败。'});},
      ).finally(()=>pending.delete(id));
    };
    const connect=(event:MessageEvent<unknown>)=>{
      if(!live||connected||event.source!==iframe.current?.contentWindow)return;
      if(!isRecord(event.data)||event.data.type!=='sr-preview-ready'||event.data.nonce!==nonce)return;
      // The child has an opaque sandbox origin; source + nonce authenticate this one handshake.
      connected=true;
      const channel=new MessageChannel();
      port=channel.port1;
      port.onmessage=handlePort;
      port.onmessageerror=()=>fail('故事舞台消息无法读取。');
      port.start();
      iframe.current!.contentWindow!.postMessage({type:'sr-preview-connect',nonce},'*',[channel.port2]);
    };
    window.addEventListener('message',connect);
    let lastAppearance='';
    const syncAppearance=()=>{
      const next=appearance(callbacks.current.fontSize);
      const signature=JSON.stringify(next);
      if(lastAppearance===signature)return;
      lastAppearance=signature;
      if(initialized)post({type:'appearance',appearance:next});
    };
    const observer=new MutationObserver(syncAppearance);
    observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','data-palette','style','class']});
    // Render a new iframe element after listeners exist. A new DOM identity prevents
    // StrictMode's earlier navigation from committing over a newer instance's src.
    setFrameNonce(nonce);
    return()=>{
      live=false;
      clearTimeout(handshakeTimer);
      observer.disconnect();
      window.removeEventListener('message',connect);
      transport.dispose();
      pending.clear();
      if(port){port.onmessage=null;port.onmessageerror=null;port.close();}
      if(transportRef.current===transport)transportRef.current=null;
      if(postRef.current===post)postRef.current=null;
      if(sendRef.current===send)sendRef.current=async()=>{throw Error('故事舞台已关闭。');};
    };
  },[sessionId,kind,scenario]);

  useEffect(()=>{
    postRef.current?.({type:'appearance',appearance:appearance(fontSize)});
  },[fontSize]);

  return <iframe
    ref={iframe}
    key={frameNonce??'preparing'}
    src={frameNonce?'/preview-frame.html?instance='+frameNonce+'#'+frameNonce:undefined}
    className={className}
    title={kind==='composed'?'作者组合故事舞台预览':'官方故事舞台预览'}
    sandbox="allow-scripts"
    data-story-preview={kind}
    data-preview-ready={status.ready}
    data-preview-error={status.error||undefined}
    style={{display:'block',border:0,width:'100%',height:'100%',minHeight:0}}
  />;
});
