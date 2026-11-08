import {marked} from 'marked';
import type {MessageComponent,MessageMatch,MessageRule} from './story-types.js';

type Span={start:number;end:number;type:'code'|'html'|'destination'|'syntax'|'inline-container';containerStart?:number;containerEnd?:number};
/** Record protected syntax locations in the original message, before replacements. */
export function protectedRanges(text:string):Span[]{
  const spans:Span[]=[];
  function walk(tokens:unknown[],source:string,base:number){
    let cursor=0;
    for(const rawToken of tokens){
      const token=rawToken as {type?:string;raw?:string;tokens?:unknown[];items?:unknown[]};
      if(typeof token.raw!=='string')continue;
      const index=source.indexOf(token.raw,cursor);if(index<0)continue;cursor=index+token.raw.length;
      const start=base+index,end=start+token.raw.length;
      if(token.type==='code'||token.type==='codespan'){spans.push({start,end,type:'code'});continue;}
      if(token.type==='html'){spans.push({start,end:start+token.raw.trimEnd().length,type:'html'});continue;}
      if(token.type==='link'){
        spans.push({start,end,type:'inline-container'});
        const delimiter=token.raw.lastIndexOf('](');if(delimiter>=0)spans.push({start:start+delimiter+1,end,type:'destination'});
      }
      if(['heading','blockquote','list_item'].includes(token.type??'')&&token.tokens?.length){
        const first=(token.tokens[0] as {raw?:unknown}).raw;
        if(typeof first==='string'){
          const prefix=token.raw.indexOf(first);
          if(prefix>0)spans.push({start,end:start+prefix,type:'syntax',containerStart:start,containerEnd:end});
        }
      }
      if(['strong','em','del'].includes(token.type??'')&&token.tokens?.length){
        spans.push({start,end,type:'inline-container'});
        const first=(token.tokens[0] as {raw?:unknown}).raw,last=(token.tokens[token.tokens.length-1] as {raw?:unknown}).raw;
        if(typeof first==='string'&&typeof last==='string'){
          const innerStart=token.raw.indexOf(first),innerEnd=token.raw.lastIndexOf(last)+last.length;
          if(innerStart>0)spans.push({start,end:start+innerStart,type:'syntax',containerStart:start,containerEnd:end});
          if(innerEnd>=0&&innerEnd<token.raw.length)spans.push({start:start+innerEnd,end,type:'syntax',containerStart:start,containerEnd:end});
        }
      }
      if(token.tokens)walk(token.tokens,token.raw,start);
      if(token.items)walk(token.items,token.raw,start);
    }
  }
  walk(marked.lexer(text),text,0);
  const open:Array<{name:string;span:Span}>=[];
  const voidElements=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
  for(const span of spans.filter(item=>item.type==='html').sort((a,b)=>a.start-b.start)){
    const raw=text.slice(span.start,span.end),tag=/^<\s*(\/?)\s*([a-zA-Z][\w:-]*)(?:\s[^>]*)?\s*>$/.exec(raw);
    if(!tag||raw.endsWith('/>')||voidElements.has(tag[2]!.toLowerCase()))continue;
    const name=tag[2]!.toLowerCase();
    if(!tag[1]){open.push({name,span});continue;}
    let index=open.length-1;while(index>=0&&open[index]!.name!==name)index--;if(index<0)continue;
    const beginning=open[index]!.span;open.splice(index);
    beginning.type='syntax';beginning.containerStart=beginning.start;beginning.containerEnd=span.end;
    span.type='syntax';span.containerStart=beginning.start;span.containerEnd=span.end;
    spans.push({start:beginning.start,end:span.end,type:'inline-container'});
  }
  return spans;
}
export function canInsertMatch(match:MessageMatch,spans:Span[],display:'inline'|'block'='inline'):boolean {
  return !spans.some(span=>{
    if(match.start>=span.end||match.end<=span.start)return false;
    if(span.type==='inline-container')return display==='block'&&!(match.start<=span.start&&match.end>=span.end);
    if(span.type==='html')return !(match.start<=span.start&&match.end>=span.end);
    if(span.type==='syntax')return !(match.start<=span.containerStart!&&match.end>=span.containerEnd!);
    return true;
  });
}

export function canShowLiteralPlaceholder(match:MessageMatch,spans:Span[]):boolean {
  if(!/^<[A-Za-z_$][\w$.-]*\s*\/>$/.test(match.match))return false;
  return !spans.some(span=>match.start<span.end&&match.end>span.start&&(
    span.type==='code'||span.type==='destination'||(span.type==='html'&&(match.start>span.start||match.end<span.end))
  ));
}

/** Reject structurally invalid ranges before resolving overlap by rule priority. */
export function selectMessageMatches(text:string,matches:MessageMatch[],rules:MessageRule[],components:Record<string,MessageComponent>):MessageMatch[]{
  const spans=protectedRanges(text),priority=new Map(rules.map((rule,index)=>[rule.id,index]));
  const candidates=[...matches].sort((a,b)=>(priority.get(a.ruleId)??Infinity)-(priority.get(b.ruleId)??Infinity)||a.start-b.start);
  const selected:MessageMatch[]=[];
  for(const match of candidates){
    const component=match.replacement.type==='component'?components[match.replacement.component]:undefined;
    const display=component?.srDisplay==='inline'?'inline':'block';
    if(text.slice(match.start,match.end)!==match.match||!canInsertMatch(match,spans,component?display:'inline'))continue;
    if(!selected.some(other=>match.start<other.end&&match.end>other.start))selected.push(match);
  }
  return selected.sort((a,b)=>a.start-b.start);
}
