import DOMPurify from 'dompurify';
import {marked} from 'marked';

type Profile='document'|'message';
const properties=new Set(['color','background-color','font-size','font-family','font-weight','font-style','line-height','text-align','text-decoration','letter-spacing','white-space','word-break','overflow-wrap','display','margin','margin-top','margin-bottom','margin-left','margin-right','padding','padding-top','padding-bottom','padding-left','padding-right','border','border-color','border-width','border-style','border-radius','max-width','min-width','width','height','opacity','box-sizing','vertical-align','list-style-type','text-indent']);
const forbidden=['script','iframe','object','embed','form','input','button','select','textarea','link','meta','base','svg','math','video','audio','source'];

// CSSOM parses declarations before the whitelist is applied. Values containing escapes,
// resource functions, variables or other functions are excluded even in isolated documents.
function declarations(style:CSSStyleDeclaration):{css:string;removed:boolean} {
  const output:string[]=[];
  for(const name of Array.from(style)){
    const value=style.getPropertyValue(name);
    if(!properties.has(name)||/[\\@;{}]/.test(value)||style.getPropertyPriority(name))continue;
    const remainder=value.replace(/(?:rgba?|hsla?)\([\d\s.,%/+\-]+\)/gi,'');
    if(/[()]/.test(remainder)||!/^[-\w\s.,#%/+'"!]+$/u.test(remainder))continue;
    output.push(`${name}:${value}`);
  }
  return {css:output.join(';'),removed:output.length<style.length};
}
function cleanStylesheet(text:string):{css:string;removed:boolean} {
  try {
    const sheet=new CSSStyleSheet();sheet.replaceSync(text);
    let removed=text.includes('@');
    const css=Array.from(sheet.cssRules).flatMap(rule=>{
      if(rule.type!==CSSRule.STYLE_RULE){removed=true;return [];}
      const item=rule as CSSStyleRule;
      const safe=declarations(item.style);removed ||= safe.removed;
      return safe.css?[`${item.selectorText}{${safe.css}}`]:[];
    }).join('\n');
    return {css,removed:removed||!!text.trim()&&!css};
  } catch {return {css:'',removed:!!text.trim()};}
}
function safeUrl(value:string,kind:'link'|'image'):boolean {
  const v=value.trim();
  if(!v||/[\u0000-\u0020\u007f]/.test(v))return false;
  if(kind==='link' && (v.startsWith('#')||v.startsWith('/')&&!v.startsWith('//')))return true;
  try {const url=new URL(v,document.baseURI);return kind==='link'?['http:','https:','mailto:'].includes(url.protocol):url.protocol==='https:';}catch{return false;}
}
export function renderWorldDocument(source:string,options:{profile:Profile;slots?:ReadonlySet<string>}):{html:string;head:string;full:boolean;removedStyles:boolean} {
  const full=/^\s*(?:<!doctype\s+html\b|<html(?:\s|>))/i.test(source);
  const parsed=full?source:String(marked.parse(source,{async:false,breaks:true}));
  // Keep style only long enough to parse it with CSSOM. Author metadata and executable content never survive.
  const purified=DOMPurify.sanitize(parsed,{WHOLE_DOCUMENT:full,ADD_TAGS:options.profile==='document'?['style']:[],FORBID_TAGS:options.profile==='document'?forbidden:[...forbidden,'style'],FORBID_ATTR:['srcdoc','srcset']});
  const doc=new DOMParser().parseFromString(purified,'text/html');
  for(const el of Array.from(doc.querySelectorAll('[data-sr-markdown="true"]'))){
    if(el.closest('pre,code,style,script'))continue;
    // Marked may already have parsed block children of an HTML block. Expand only
    // remaining text nodes, preserving those children and treating nested marked
    // containers independently.
    for(const node of Array.from(el.childNodes)){
      if(node.nodeType!==Node.TEXT_NODE||!node.textContent?.trim())continue;
      const html=String(marked.parse(node.textContent,{async:false,breaks:true}));
      const template=doc.createElement('template');
      template.innerHTML=DOMPurify.sanitize(html,{FORBID_TAGS:[...forbidden,'style'],FORBID_ATTR:['srcdoc','srcset']});
      node.replaceWith(template.content);
    }
  }
  let removedStyles=false;
  const seenSlots=new Set<string>();
  for(const el of Array.from(doc.querySelectorAll('*'))){
    for(const attr of Array.from(el.attributes)){
      const name=attr.name.toLowerCase();
      if(name.startsWith('data-sr-')){
        if(name==='data-sr-slot' && options.slots?.has(attr.value) && !seenSlots.has(attr.value)){seenSlots.add(attr.value);continue;}
        el.removeAttribute(attr.name);
      }
    }
    if(el.hasAttribute('style')){
      const original=el.getAttribute('style')??'';const safe=declarations((el as HTMLElement).style);
      removedStyles ||= safe.removed || (!!original.trim() && !(el as HTMLElement).style.length);
      el.removeAttribute('style');if(safe.css)el.setAttribute('style',safe.css);
    }
    if(el.hasAttribute('href')){
      if(!safeUrl(el.getAttribute('href')??'','link'))el.removeAttribute('href');
      else {el.setAttribute('target','_blank');el.setAttribute('rel','noopener noreferrer');}
    }
    if(el.hasAttribute('src')&&!safeUrl(el.getAttribute('src')??'','image'))el.removeAttribute('src');
    el.removeAttribute('srcset');
  }
  let head='';
  if(options.profile==='document'){
    head=Array.from(doc.querySelectorAll('style')).map(el=>{const result=cleanStylesheet(el.textContent??'');removedStyles ||= result.removed;return result.css;}).filter(Boolean).map(css=>`<style>${css}</style>`).join('');
  }
  doc.querySelectorAll('style').forEach(el=>el.remove());
  return {html:doc.body.innerHTML,head,full,removedStyles};
}
