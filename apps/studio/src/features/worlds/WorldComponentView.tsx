import {useEffect,useRef,useState} from 'react';
import {compileComponents} from '../../../../../packages/sr-ui-compiler/src/index';
import {api} from '../../api';
import {randomId} from '../../random-id';
import {worldComponentURL} from '../../stage-url';
import {createPreviewCompiler} from './preview-compilation-cache';
import {compileWorldComponents} from './compile-world-components';
import {worldAssetBaseUrl} from '../../world-assets';
import {worldStateQueries,readWorldState} from './world-component-protocol';
import type {WorldDetail} from './api/worlds';

const compilePreview=createPreviewCompiler(compileComponents);

export function WorldComponentView({world,entry,title}:{world:WorldDetail;entry:string;title:string}) {
  const [revision,setRevision]=useState(0);
  return <MountedWorldComponent key={world.id+':'+entry+':'+revision} world={world} entry={entry} title={title} retry={()=>setRevision(value=>value+1)}/>;
}
function MountedWorldComponent({world,entry,title,retry}:{world:WorldDetail;entry:string;title:string;retry:()=>void}) {
  const frame=useRef<HTMLIFrameElement>(null),[error,setError]=useState(''),[loaded,setLoaded]=useState(false),[height,setHeight]=useState(1);
  const [source,setSource]=useState<string>(),onFrameLoad=useRef<(()=>void)|undefined>(undefined);
  useEffect(()=>{
    const nonce=randomId();
    setSource(undefined);setLoaded(false);setHeight(1);setError('');
    let gone=false,port:MessagePort|undefined,connected=false,ready=false,compiled:Awaited<ReturnType<typeof compileComponents>>|undefined;
    let expectedOrigin:string|undefined;
    const abort=new AbortController();
    const fail=(reason?:unknown)=>{if(gone)return;setError(reason instanceof Error?reason.message:typeof reason==='string'?reason:'组件加载失败，请重试或检查世界卡组件。');gone=true;clearTimeout(timer);abort.abort();port?.close();};
    const timer=setTimeout(fail,20000);
    onFrameLoad.current=()=>{
      if(gone||!expectedOrigin)return;
      // A document navigation revokes the bridge; only an explicit retry reconnects.
      if(connected){fail();return;}
      frame.current?.contentWindow?.postMessage({type:'sr-world-probe',nonce},expectedOrigin);
    };
    function appearance(){if(gone)return;const style=getComputedStyle(document.documentElement);port?.postMessage({type:'appearance',theme:document.documentElement.dataset.theme,colors:Object.fromEntries(['--text','--text-muted','--surface','--accent'].map(key=>[key,style.getPropertyValue(key).trim()]))});}
    function render(){if(ready&&compiled){appearance();port?.postMessage({type:'render',entry,modules:compiled,assetBaseUrl:worldAssetBaseUrl(expectedOrigin,world.id)});}}
    const listener=(event:MessageEvent)=>{
      if(gone||connected||!expectedOrigin||event.source!==frame.current?.contentWindow||event.origin!==expectedOrigin||event.data?.type!=='sr-world-ready'||event.data.nonce!==nonce)return;
      connected=true;const channel=new MessageChannel();port=channel.port1;
      port.onmessage=async({data})=>{
        if(gone||!data||typeof data!=='object')return;
        if(data.type==='ready'){ready=true;render();}
        else if(data.type==='mounted'){clearTimeout(timer);setLoaded(true);}
        else if(data.type==='ui-error')fail(data.message);
        else if(data.type==='resize'&&Number.isFinite(data.height)&&data.height>=0&&data.height<=100000)setHeight(Math.max(1,Math.ceil(data.height)));
        else if(data.type==='request'&&Number.isSafeInteger(data.id)){
          try {
            if(JSON.stringify(data).length>300000)throw Error('REQUEST_TOO_LARGE');
            const queries=worldStateQueries(data.method,data.data);
            const snapshot=await api('v1/worlds/'+encodeURIComponent(world.id)+'/state',{signal:abort.signal});
            if(!gone)port?.postMessage({type:'response',id:data.id,data:queries.map(query=>({...query,value:readWorldState(snapshot.global,query.path)}))});
          }catch(err){if(!gone)port?.postMessage({type:'response',id:data.id,error:err instanceof Error?err.message:'State read failed'});}
        }
      };
      port.start();frame.current?.contentWindow?.postMessage({type:'sr-world-connect',nonce},expectedOrigin,[channel.port2]);
    };
    window.addEventListener('message',listener);
    const theme=new MutationObserver(appearance);theme.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','style','class']});
    void compileWorldComponents(world,sources=>compilePreview(world.id,sources),abort.signal).then(value=>{if(!gone){compiled=value;render();}}).catch(fail);
    void api('v1/runtime/web-config',{signal:abort.signal}).then(config=>{
      if(gone)return;
      const url=worldComponentURL(config,location.origin,nonce);
      expectedOrigin=url.origin;setSource(url.href);
    }).catch(fail);
    return()=>{gone=true;clearTimeout(timer);abort.abort();theme.disconnect();port?.close();onFrameLoad.current=undefined;window.removeEventListener('message',listener);};
  },[world.id,world.data.components,entry]);
  if(error)return <div role="alert"><p>{error}</p><button className="button" onClick={retry}>重试</button></div>;
  return <>{!loaded&&<p role="status">正在加载组件…</p>}{source&&<iframe key={source} ref={frame} title={title} data-world-component={entry} src={source} sandbox="allow-scripts allow-same-origin" onLoad={()=>onFrameLoad.current?.()} style={{display:'block',width:'100%',height,border:0,visibility:loaded?'visible':'hidden'}}/>}</>;
}
