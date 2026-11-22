import {marked} from 'marked';
import {roleplayLiteralMask} from '@sillyrealms/roleplay';
import {protectedRanges} from './message-ranges.js';

type Range={start:number;end:number};
type Insertion={at:number;text:string};
const overlaps=(a:Range,b:Range)=>a.start<b.end&&a.end>b.start;

/** Mark only source ranges which survived author replacements. Markers are random,
 * are never author-controlled attributes, and are consumed after sanitization. */
export function roleplayMarkers(source:string,blocked:Range[],nonce:string,composerQuotes:ReadonlySet<number> = new Set()){
  const protectedSpans=protectedRanges(source),literalMask=roleplayLiteralMask(source);
  const insertions:Insertion[]=[];
  let index=0;
  // Display-only quotation recognition: do not alter the Composer/wire protocol.
  // A pair may contain inline Markdown, but never code, HTML, image syntax,
  // link destinations, author replacements or separate paragraphs.
  const unsafe=(range:Range)=>literalMask.subarray(range.start,range.end).some(Boolean)||blocked.some(item=>overlaps(item,range))||protectedSpans.some(item=>{
    if(item.type==='inline-container')return false;
    if(item.type==='syntax'){
      // Entire raw HTML containers stay author-owned; emphasis delimiters are safe.
      if(source[item.containerStart!]==='<')return overlaps({start:item.containerStart!,end:item.containerEnd!},range);
      if(/^[*_~]+$/.test(source.slice(item.start,item.end)))return false;
    }
    return overlaps(item,range);
  });
  const escaped=(at:number)=>{let count=0;while(at>0&&source[--at]==='\\')count++;return count%2===1;};
  let opening=-1,closing='',composerPair=false;
  for(let at=0;at<source.length;at++){
    const char=source[at];
    if(char==='\n'&&/^\n[\t \r]*\n/.test(source.slice(at))){opening=-1;continue;}
    if(char!=='“'&&char!=='”'&&char!=='"')continue;
    const encoded=composerQuotes.has(at);
    if(!encoded&&escaped(at))continue;
    // Inside a dedicated speech block the Composer also escapes its inner quotes.
    if(opening>=0&&encoded!==composerPair)continue;
    if(unsafe({start:at,end:at+1})){opening=-1;continue;}
    const start=encoded?at-1:at;
    if(opening<0){if(char!=='”'){opening=start;composerPair=encoded;closing=char==='“'?'”':'"';}continue;}
    if(char!==closing){if(char==='“'&&closing==='”')opening=start;continue;}
    const range={start:opening,end:at+1};opening=-1;
    if(unsafe(range))continue;
    const marker=`SRRP${nonce}S${index++}X`;
    insertions.push({at:range.start,text:marker+'A'},{at:range.end,text:marker+'B'});
  }
  // Top-level Markdown blockquotes alone receive the thought style; raw HTML
  // blockquotes and ambiguous nested constructs are deliberately left unchanged.
  let cursor=0;
  for(const token of marked.lexer(source,{breaks:true})){
    const start=source.indexOf(token.raw,cursor);if(start<0)continue;cursor=start+token.raw.length;
    if(token.type!=='blockquote')continue;
    const range={start,end:cursor};
    if(blocked.some(item=>overlaps(item,range)))continue;
    const prefix=/^ {0,3}>[\t ]?/.exec(token.raw);if(!prefix)continue;
    insertions.push({at:start+prefix[0].length,text:`SRRP${nonce}T${index++}X`});
  }
  return insertions.sort((a,b)=>a.at-b.at);
}

/** Operate only on sanitized, local DOM; portal targets and links are never touched. */
export function applyRoleplayMarkers(root:DocumentFragment,nonce:string){
  // A Markdown soft line break becomes a <br> and splits the marker pair
  // across text nodes. Wrap sibling text, breaks and inline emphasis together;
  // links, code, author HTML and portal slots retain the conservative fallback.
  const markerPrefix=`SRRP${nonce}S`;
  const ids=new Set<string>();
  const initial=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
  while(initial.nextNode()){
    const text=(initial.currentNode as Text).data;
    for(const match of text.matchAll(new RegExp(`${markerPrefix}(\\d+)XA`,'g')))ids.add(match[1]!);
  }
  for(const id of ids){
    const opening=`${markerPrefix}${id}XA`,closing=`${markerPrefix}${id}XB`;
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
    let first:Text|undefined,last:Text|undefined;
    while(walker.nextNode()){
      const node=walker.currentNode as Text;
      if(node.data.includes(opening))first=node;
      if(node.data.includes(closing)){last=node;break;}
    }
    if(!first||!last||first===last)continue;
    if(!first.parentElement||first.parentElement.closest('pre,code,a,[data-sr-slot]'))continue;
    if(first.parentNode!==last.parentNode)continue;
    let current:Node|null=first.nextSibling,safe=true;
    while(current&&current!==last){
      if(current.nodeType!==Node.TEXT_NODE&&(!(current instanceof Element)||!['BR','STRONG','EM','DEL','S'].includes(current.tagName)||Array.from(current.querySelectorAll('*')).some(el=>!['BR','STRONG','EM','DEL','S'].includes(el.tagName)))){safe=false;break;}
      current=current.nextSibling;
    }
    if(!safe||current!==last)continue;
    const range=document.createRange();
    range.setStart(first,first.data.indexOf(opening)+opening.length);
    range.setEnd(last,last.data.indexOf(closing));
    const span=document.createElement('span');span.className='sr-rp-speech';
    span.append(range.extractContents());range.insertNode(span);
  }
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
  const nodes:Text[]=[];while(walker.nextNode())nodes.push(walker.currentNode as Text);
  const marker=new RegExp(`SRRP${nonce}(?:S\\d+X[AB]|T\\d+X)`,'g');
  const pair=new RegExp(`SRRP${nonce}S(\\d+)XA([\\s\\S]*?)SRRP${nonce}S\\1XB`,'g');
  const thought=new RegExp(`SRRP${nonce}T\\d+X`,'g');
  for(const node of nodes){
    const original=node.data;if(!original.includes(`SRRP${nonce}`))continue;
    const parent=node.parentElement;
    const allowed=!!parent&&!parent.closest('pre,code,a,[data-sr-slot]');
    if(allowed&&thought.test(original))parent.closest('blockquote')?.classList.add('sr-rp-thought');
    if(!allowed){node.data=original.replace(marker,'');continue;}
    const fragment=document.createDocumentFragment();let cursor=0,match:RegExpExecArray|null;
    pair.lastIndex=0;
    while((match=pair.exec(original))){
      fragment.append(document.createTextNode(original.slice(cursor,match.index).replace(marker,'')));
      const span=document.createElement('span');span.className='sr-rp-speech';span.textContent=match[2]!.replace(marker,'');fragment.append(span);cursor=match.index+match[0].length;
    }
    if(cursor){fragment.append(document.createTextNode(original.slice(cursor).replace(marker,'')));node.replaceWith(fragment);}
    else node.data=original.replace(marker,'');
    thought.lastIndex=0;
  }
}
