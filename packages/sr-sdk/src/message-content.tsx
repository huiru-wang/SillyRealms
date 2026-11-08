import React,{useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {marked} from 'marked';
import DOMPurify from 'dompurify';
import {useStoryConfiguration,type MessageComponentProps,type MessageMatch} from './story-context.js';
import type {ChatMessage} from './run-contract.js';
import {canShowLiteralPlaceholder,protectedRanges,selectMessageMatches} from './message-ranges.js';

const styles=new Set(['color','background-color','font-size','font-family','font-weight','font-style','line-height','text-align','text-decoration','letter-spacing','white-space','word-break','overflow-wrap','display','margin','margin-top','margin-bottom','margin-left','margin-right','padding','padding-top','padding-bottom','padding-left','padding-right','border','border-color','border-width','border-style','border-radius','max-width','min-width','width','height','opacity']);
function clean(html:string){
  const safe=DOMPurify.sanitize(html,{FORBID_TAGS:['style','script','iframe','object','embed','form','link','meta','base']});
  const doc=new DOMParser().parseFromString(safe,'text/html');
  for(const element of doc.body.querySelectorAll<HTMLElement>('[style]')){
    const original=element.style;const allowed:Array<[string,string]>=[];
    for(const property of Array.from(original)){
      const value=original.getPropertyValue(property);
      if(styles.has(property)&&!/[\\@]/.test(value)&&!/(url|expression|var|attr)\s*\(/i.test(value))allowed.push([property,value]);
    }
    element.removeAttribute('style');for(const [property,value] of allowed)element.style.setProperty(property,value);
  }
  return doc.body.innerHTML;
}
function substitute(template:string,match:MessageMatch){
  return template.replace(/\$([$&]|\d{1,2}|<[^>]+>)/g,(whole,token:string)=>{
    if(token==='$')return '$';if(token==='&')return match.match;
    if(token.startsWith('<'))return Object.keys(match.namedGroups).length?match.namedGroups[token.slice(1,-1)]??'':whole;
    const n=Number(token);if(n>0&&n<=match.groups.length)return match.groups[n-1]??'';
    if(token.length===2&&Number(token[0])>0&&Number(token[0])<=match.groups.length)return (match.groups[Number(token[0])-1]??'')+token[1];
    return whole;
  });
}
function escapeHtml(text:string){return text.replace(/[&<>]/g,char=>char==='&'?'&amp;':char==='<'?'&lt;':'&gt;');}
class ComponentBoundary extends React.Component<{children:React.ReactNode;fallback:string},{failed:boolean}>{
  state={failed:false};static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?<span>{this.props.fallback} <small role="status">组件显示失败，已保留原文</small></span>:this.props.children;}
}
export function MessageContent({message,runId}:{message:ChatMessage;runId:string}){
  const config=useStoryConfiguration();
  const [matches,setMatches]=useState<MessageMatch[]>([]),[targets,setTargets]=useState<Element[]>([]),[failed,setFailed]=useState(false),[warning,setWarning]=useState(false);
  const ref=useRef<HTMLDivElement>(null),nonce=useRef(Math.random().toString(36).slice(2));
  useEffect(()=>{
    let valid=true;
    if(!config.rules.length){setMatches([]);setFailed(false);setWarning(false);return;}
    const timer=setTimeout(()=>{void config.match(message.text,message.role).then(result=>{if(valid){setMatches(result.matches);setWarning(result.warning);setFailed(false);}}).catch(()=>{if(valid){setMatches([]);setWarning(false);setFailed(true);}});},60);
    return()=>{valid=false;clearTimeout(timer);};
  },[message.text,message.role,config]);
  const rendered=useMemo(()=>{
    let cursor=0,raw='';const portals:Array<{key:string;component:React.ComponentType<MessageComponentProps>;props:MessageComponentProps}>=[];
    const selected=selectMessageMatches(message.text,matches,config.rules,config.components);
    const spans=protectedRanges(message.text);
    const fallback=matches.filter(item=>item.replacement.type==='component'&&!selected.includes(item)&&canShowLiteralPlaceholder(item,spans)&&!selected.some(other=>item.start<other.end&&item.end>other.start));
    const parts=[...selected.map(item=>({item,literal:false})),...fallback.map(item=>({item,literal:true}))].sort((a,b)=>a.item.start-b.item.start);
    let structuralWarning=false,missingComponent=false;
    for(const {item,literal} of parts){
      const component=item.replacement.type==='component'?config.components[item.replacement.component]:undefined;
      if(item.start<cursor)continue;
      raw+=message.text.slice(cursor,item.start);cursor=item.end;
      if(literal){raw+=escapeHtml(item.match);structuralWarning=true;continue;}
      if(item.replacement.type==='component'){
        const Component=component;
        if(!Component){raw+=escapeHtml(item.match);missingComponent=true;continue;}
        const key=nonce.current+'-'+encodeURIComponent(item.ruleId)+'-'+item.start,inline=Component.srDisplay==='inline';
        raw+=inline?`<span data-sr-slot="${key}"></span>`:`\n\n<div data-sr-slot="${key}"></div>\n\n`;
        portals.push({key,component:Component,props:{match:item.match,groups:item.groups,namedGroups:item.namedGroups,message:{id:message.id,role:message.role},runId}});
      } else raw+=substitute(item.replacement.content,item);
    }
    raw+=message.text.slice(cursor);
    return {html:clean(marked.parse(failed?escapeHtml(message.text):raw,{async:false,breaks:true}) as string),portals:failed?[]:portals,structuralWarning,missingComponent};
  },[message,matches,config,runId,failed]);
  useLayoutEffect(()=>{
    const container=ref.current;if(!container)return;
    const existing=new Map(Array.from(container.querySelectorAll('[data-sr-slot]')).map(node=>[node.getAttribute('data-sr-slot'),node]));
    const template=document.createElement('template');template.innerHTML=rendered.html;
    for(const slot of template.content.querySelectorAll('[data-sr-slot]')){
      const previous=existing.get(slot.getAttribute('data-sr-slot'));
      if(previous&&previous.tagName===slot.tagName)slot.replaceWith(previous);
    }
    container.replaceChildren(template.content);
    setTargets(Array.from(container.querySelectorAll('[data-sr-slot]')));
  },[rendered]);
  return <div className="sr-rich"><div ref={ref}/>{failed&&<small role="status">消息展示规则处理失败，已显示原文</small>}{(warning||rendered.structuralWarning)&&<small role="status">部分消息展示规则无效，已保留原文</small>}{rendered.missingComponent&&<small role="status">消息组件不可用，已保留原文</small>}{rendered.portals.map(portal=>{
    const target=targets.find(node=>node.getAttribute('data-sr-slot')===portal.key);if(!target)return null;
    const Component=portal.component;return createPortal(<ComponentBoundary fallback={portal.props.match}><Component {...portal.props}/></ComponentBoundary>,target,portal.key);
  })}</div>;
}
