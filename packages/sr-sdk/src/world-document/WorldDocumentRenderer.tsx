import React,{useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {renderWorldDocument} from './render.js';

const baseStyle=`html,body{margin:0;min-height:0;background:var(--sr-document-background,#fff)}body{font:15px/1.7 system-ui,sans-serif;color:var(--sr-document-ink,#20212a);overflow-wrap:anywhere}img{max-width:100%;height:auto}pre{overflow-x:auto}table{display:block;max-width:100%;overflow-x:auto;border-collapse:collapse}th,td{border:1px solid #8886;padding:.35em .6em}a{color:inherit;text-decoration:underline}blockquote{margin:1em 0;padding-left:1em;border-left:3px solid #8886}p,ul,ol,pre,blockquote{margin:.7em 0}h1,h2,h3,h4{line-height:1.3;margin:1.1em 0 .5em}body>:first-child{margin-top:0}body>:last-child{margin-bottom:0}`;
export function WorldDocumentRenderer({content,title='文档',presentation='isolated',density='reading',className='',showStyleWarning=true}:{content:string;title?:string;presentation?:'isolated'|'inline';density?:'reading'|'chat';className?:string;showStyleWarning?:boolean}){
  const frame=useRef<HTMLIFrameElement>(null);
  const [themeVersion,setThemeVersion]=useState(0);
  const [background,setBackground]=useState('');
  useEffect(()=>{const observer=new MutationObserver(()=>setThemeVersion(version=>version+1));observer.observe(document.documentElement,{attributes:true,attributeFilter:['class','style','data-theme']});return()=>observer.disconnect();},[]);
  useLayoutEffect(()=>{
    let node=frame.current?.parentElement;
    while(node){
      const color=getComputedStyle(node).backgroundColor;
      if(color!=='transparent' && color!=='rgba(0, 0, 0, 0)'){setBackground(color);return;}
      node=node.parentElement;
    }
    setBackground(getComputedStyle(document.documentElement).getPropertyValue('--surface').trim()||'#fff');
  },[themeVersion,presentation]);
  const rendered=useMemo(()=>renderWorldDocument(content,{profile:presentation==='isolated'?'document':'message'}),[content,presentation]);
  const srcDoc=useMemo(()=>{
    const ink=getComputedStyle(document.documentElement).getPropertyValue('--ink').trim();
    const color=CSS.supports('color',ink)?ink:'#20212a';
    const bg=CSS.supports('color',background)?background:'#fff';
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{--sr-document-ink:${color};--sr-document-background:${bg}}${baseStyle}</style>${rendered.head}<style>html,body{height:auto!important;min-height:0!important;max-height:none!important;overflow:visible!important}</style></head><body>${rendered.html}</body></html>`;
  },[rendered,themeVersion,background]);
  useLayoutEffect(()=>{
    const el=frame.current;if(!el)return;
    let observer:ResizeObserver|undefined,doc:Document|null=null;
    const update=()=>{if(!doc?.body)return;el.style.height='0px';el.style.height=Math.max(doc.body.scrollHeight,doc.documentElement.scrollHeight)+'px';};
    const setup=()=>{observer?.disconnect();doc?.removeEventListener('load',update,true);doc=el.contentDocument;if(!doc?.body)return;update();observer=new ResizeObserver(update);observer.observe(doc.body);doc.addEventListener('load',update,true);};
    el.addEventListener('load',setup);
    setup();
    return()=>{el.removeEventListener('load',setup);doc?.removeEventListener('load',update,true);observer?.disconnect();};
  },[srcDoc,presentation]);
  if(presentation==='inline')return <div className={`sr-rich ${className}`} data-density={density} dangerouslySetInnerHTML={{__html:rendered.html}}/>;
  return <>{showStyleWarning&&rendered.removedStyles&&<p role="status" style={{fontSize:"0.8rem",opacity:0.75}}>部分文档样式因安全限制未显示。</p>}<iframe ref={frame} title={title} className={`character-document ${className}`} sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcDoc={srcDoc} style={{display:'block',width:'100%',border:0}}/></>;
}
