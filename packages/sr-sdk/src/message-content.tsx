import React,{useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {parseRoleplay} from '@sillyrealms/roleplay';
import {applyRoleplayMarkers,roleplayMarkers} from './world-story-roleplay.js';
import {renderWorldDocument} from './world-document/render.js';
import {useStoryConfiguration,type MessageComponentProps,type MessageMatch} from './story-context.js';
import type {ChatMessage} from './run-contract.js';
import {canShowLiteralPlaceholder,protectedRanges,selectMessageMatches} from './message-ranges.js';
import {updateMessageDOM} from './message-dom.js';

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
export const MessageContent = React.memo(function MessageContent({message,runId}:{message:ChatMessage;runId:string}){
  const config=useStoryConfiguration();
  const [matches,setMatches]=useState<MessageMatch[]>([]),[targets,setTargets]=useState<Element[]>([]),[failed,setFailed]=useState(false),[warning,setWarning]=useState(false);
  const ref=useRef<HTMLDivElement>(null),nonce=useRef(Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join(''));
  useEffect(()=>{
    let valid=true;
    if(!config.rules.length){setMatches([]);setFailed(false);setWarning(false);return;}
    const timer=setTimeout(()=>{void config.match(message.text,message.role).then(result=>{if(valid){setMatches(result.matches);setWarning(result.warning);setFailed(false);}}).catch(()=>{if(valid){setMatches([]);setWarning(false);setFailed(true);}});},60);
    return()=>{valid=false;clearTimeout(timer);};
  },[message.text,message.role,config]);
  const rendered=useMemo(()=>{
    let cursor=0,raw='';const portals:Array<{key:string;component:React.ComponentType<MessageComponentProps>;props:MessageComponentProps}>=[];
    const parsed=parseRoleplay(message.text,message.role);
    const instructions=parsed.ranges.filter(range=>range.kind==='instruction');
    const selected=failed?[]:selectMessageMatches(message.text,matches,config.rules,config.components,instructions);
    const spans=protectedRanges(message.text);
    const fallback=failed?[]:matches.filter(item=>item.replacement.type==='component'&&!selected.includes(item)&&canShowLiteralPlaceholder(item,spans)&&!instructions.some(range=>item.start<range.end&&item.end>range.start)&&!selected.some(other=>item.start<other.end&&item.end>other.start));
    const blocked=[...selected,...fallback,...instructions];
    const markers=failed?[]:roleplayMarkers(message.text,parsed.ranges,blocked,nonce.current);
    // Tags which were not recognized as valid user instructions are literal text,
    // except inside Markdown code or existing HTML where the renderer handles them.
    const literalTags=Array.from(message.text.matchAll(/<\/?sr_instruction>/g)).filter(match=>{
      const start=match.index!,lineStart=message.text.lastIndexOf('\n',start-1)+1,lineEnd=message.text.indexOf('\n',start);
      const standalone=message.text.slice(lineStart,lineEnd<0?message.text.length:lineEnd).trim()===match[0];
      return !blocked.some(range=>start<range.end&&start+match[0].length>range.start)&&!spans.some(span=>(span.type==='code'||(span.type==='html'&&!standalone&&start!==span.start))&&start<span.end&&start+match[0].length>span.start)&&!(start>0&&message.text[start-1]==='\\');
    });
    // Decode protocol-only escapes after matching on original offsets. Ordinary
    // Markdown escapes are left to marked, and code/HTML regions stay literal.
    const htmlContainers=spans.filter(span=>span.type==='syntax'&&span.containerStart!==undefined&&span.containerEnd!==undefined&&message.text[span.start]==='<').map(span=>({start:span.containerStart!,end:span.containerEnd!}));
    const displayEscapes:Array<{at:number;end:number;text:string}>=[];
    if(message.role==='user'){
      for(let index=0;index<message.text.length;index++){
        if(message.text[index]!=='\\')continue;
        let end=index+1;while(message.text[end]==='\\')end++;
        const count=end-index,next=message.text[end];
        const unprotected=(finish:number)=>!blocked.some(range=>index<range.end&&finish>range.start)&&!spans.some(span=>(span.type==='code'||span.type==='html')&&index<span.end&&finish>span.start)&&!htmlContainers.some(range=>index<range.end&&finish>range.start);
        if(count===1&&(index===0||message.text[index-1]==='\n')&&(end===message.text.length||next==='\n')&&unprotected(end))displayEscapes.push({at:index,end,text:''});
        else if(count%2===1&&(next==='“'||next==='”')&&unprotected(end+1))displayEscapes.push({at:end-1,end:end+1,text:next==='“'?'&#8220;':'&#8221;'});
        index=end-1;
      }
    }
    const plain=(start:number,end:number)=>{
      const changes=[...displayEscapes.filter(item=>item.at>=start&&item.end<=end),...markers.filter(item=>item.at>=start&&(item.at<end||(end===message.text.length&&item.at===end))).map(item=>({at:item.at,end:item.at,text:item.text})),...literalTags.filter(item=>item.index!>=start&&item.index!+item[0].length<=end).map(item=>({at:item.index!,end:item.index!+item[0].length,text:escapeHtml(item[0])}))].sort((a,b)=>a.at-b.at||a.end-b.end);
      let result='',position=start;for(const change of changes){if(change.at<position)continue;result+=message.text.slice(position,change.at)+change.text;position=change.end;}return result+message.text.slice(position,end);
    };
    const parts=[...selected.map(item=>({start:item.start,end:item.end,item,literal:false,instruction:false})),...fallback.map(item=>({start:item.start,end:item.end,item,literal:true,instruction:false})),...instructions.map(range=>({start:range.start,end:range.end,item:undefined,literal:false,instruction:true}))].sort((a,b)=>a.start-b.start);
    let structuralWarning=false,missingComponent=false;
    for(const part of parts){
      if(part.start<cursor)continue;
      raw+=plain(cursor,part.start);cursor=part.end;
      if(part.instruction)continue;
      const item=part.item!;
      const component=item.replacement.type==='component'?config.components[item.replacement.component]:undefined;
      if(part.literal){raw+=escapeHtml(item.match);structuralWarning=true;continue;}
      if(item.replacement.type==='component'){
        const Component=component;
        if(!Component){raw+=escapeHtml(item.match);missingComponent=true;continue;}
        const key=nonce.current+'-'+encodeURIComponent(item.ruleId)+'-'+item.start,inline=Component.srDisplay==='inline';
        raw+=inline?`<span data-sr-slot="${key}"></span>`:`\n\n<div data-sr-slot="${key}"></div>\n\n`;
        portals.push({key,component:Component,props:{match:item.match,groups:item.groups,namedGroups:item.namedGroups,message:{id:message.id,role:message.role},runId}});
      } else raw+=substitute(item.replacement.content,item);
    }
    raw+=plain(cursor,message.text.length);
    return {html:renderWorldDocument(raw,{profile:'message',slots:new Set(portals.map(portal=>portal.key))}).html,portals,structuralWarning,missingComponent,instructions:parsed.instructionText};
  },[message.id,message.role,message.text,matches,config,runId,failed]);
  useLayoutEffect(()=>{
    const container=ref.current;if(!container)return;
    const template=document.createElement('template');template.innerHTML=rendered.html;
    applyRoleplayMarkers(template.content,nonce.current);
    updateMessageDOM(container,template.content);
    setTargets(Array.from(container.querySelectorAll('[data-sr-slot]')));
  },[rendered]);
  return <div className="sr-rich"><div ref={ref}/>{rendered.instructions.length>0&&<div className="sr-rp-instruction-panel"><span>叙事指令</span>{rendered.instructions.map((text,index)=><p key={index}>{text}</p>)}</div>}{failed&&<small role="status">消息展示规则处理失败，已显示原文</small>}{(warning||rendered.structuralWarning)&&<small role="status">部分消息展示规则无效，已保留原文</small>}{rendered.missingComponent&&<small role="status">消息组件不可用，已保留原文</small>}{rendered.portals.map(portal=>{
    const target=targets.find(node=>node.getAttribute('data-sr-slot')===portal.key);if(!target)return null;
    const Component=portal.component;return createPortal(<ComponentBoundary fallback={portal.props.match}><Component {...portal.props}/></ComponentBoundary>,target,portal.key);
  })}</div>;
}, (previous,next) => previous.runId===next.runId && previous.message.id===next.message.id &&
  previous.message.role===next.message.role && previous.message.text===next.message.text);
