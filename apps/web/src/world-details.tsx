import React, {useEffect, useMemo, useRef} from 'react';
import DOMPurify from 'dompurify';
import {marked} from 'marked';

type Definition = {type?:string;description?:string;initial?:unknown;properties?:Record<string,Definition>;items?:Definition;values?:unknown[];min?:number;max?:number;nullable?:boolean;load?:{mode?:string}};
const scopes = [
  {id:'global',title:'世界状态',description:'同一世界卡下的会话共享，记录世界范围持久的信息。'},
  {id:'session',title:'会话状态',description:'属于单个会话，保存该会话独有的信息。'},
  {id:'message',title:'消息状态',description:'随消息历史和分支变化，记录当前剧情中的状态。'},
] as const;
function printable(value:unknown) { return typeof value === 'string' ? value : JSON.stringify(value); }
function StateNode({name,definition}:{name:string;definition:Definition}) {
  const children=Object.entries(definition.properties ?? {});
  const nested=definition.items;
  const details=[definition.type,definition.nullable?'可为空':null,definition.min!==undefined?`最小 ${definition.min}`:null,definition.max!==undefined?`最大 ${definition.max}`:null,definition.values?.length?`可选：${definition.values.map(printable).join('、')}`:null,definition.load?.mode?`加载：${definition.load.mode}`:null].filter(Boolean);
  return <details className="state-node"><summary><span className="state-node-name">{name}</span><span className="state-node-meta">{details.join(' · ')}</span></summary><div className="state-node-content">{definition.description&&<p>{definition.description}</p>}{Object.hasOwn(definition,'initial')&&<div className="state-initial"><span>初始值</span><code>{printable(definition.initial)}</code></div>}{children.map(([key,value])=><StateNode key={key} name={key} definition={value}/>)}{nested&&<StateNode name="元素定义" definition={nested}/>} {!definition.description&&!children.length&&!nested&&!Object.hasOwn(definition,'initial')&&<p className="state-empty">没有更多定义</p>}</div></details>;
}
export function WorldState({state}:{state?:{scopes?:Record<string,Record<string,Definition>>}}) {
 return <div className="state-view"><div className="state-view-intro"><div><div className="eyebrow">STATE SCHEMA</div><h2>世界状态</h2></div><p>这些是世界卡声明的状态定义与初始值，实际状态随世界、会话与剧情变化。</p></div>{scopes.map(scope=>{const modules=Object.entries(state?.scopes?.[scope.id] ?? {});return <details className="state-scope" key={scope.id} open><summary><span><strong>{scope.title}</strong><small>{scope.description}</small></span><span className="state-count">{modules.length} 项</span></summary><div className="state-scope-content">{modules.length?modules.map(([name,definition])=><StateNode key={name} name={name} definition={definition}/>):<p className="state-empty">此作用域尚未定义状态</p>}</div></details>})}</div>;
}

/** Creator HTML stays in a scriptless, network-restricted frame; its height follows its content. */
export function CharacterDescription({text,title="角色介绍"}:{text:string;title?:string}) {
 const frame=useRef<HTMLIFrameElement>(null);
 const doc=useMemo(()=>{
   const full=/<(?:!doctype\s+html|html)(?:\s|>)/i.test(text);
   const html=full?text:String(marked.parse(text,{async:false,breaks:true}));
   const clean=DOMPurify.sanitize(html,{WHOLE_DOCUMENT:true,FORBID_TAGS:['script','iframe','object','embed','base','form','meta','link'],FORBID_ATTR:['srcdoc']});
   const color=getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#20212a';
   const style='<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src https: data: blob:; font-src data:; style-src \'unsafe-inline\';"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;min-height:0}body{font-family:system-ui,sans-serif;overflow-wrap:anywhere;color:'+color+'}img,video{max-width:100%;height:auto}</style>';
   return clean.replace(/<head[^>]*>/i,match=>match+style);
 },[text]);
 useEffect(()=>{
   const el=frame.current;if(!el)return;
   let observer:ResizeObserver|undefined;
   const update=()=>{const document=el.contentDocument;if(!document?.body)return;el.style.height='0px';el.style.height=Math.max(document.body.scrollHeight,document.documentElement.scrollHeight)+'px';};
   const setup=()=>{observer?.disconnect();const document=el.contentDocument;if(!document?.body)return;update();observer=new ResizeObserver(update);observer.observe(document.body);document.querySelectorAll('img').forEach(img=>img.addEventListener('load',update));};
   el.addEventListener('load',setup);return()=>{el.removeEventListener('load',setup);observer?.disconnect();};
 },[doc]);
 return <iframe ref={frame} title={title} className="character-document" sandbox="allow-same-origin" srcDoc={doc}/>;
}
