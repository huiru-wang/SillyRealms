import {Children,isValidElement,useId,useEffect,useLayoutEffect,useMemo,useRef,useState,type ReactNode,type SelectHTMLAttributes,type KeyboardEvent} from 'react';
import {Check,ChevronDown} from 'lucide-react';
import styles from './Select.module.css';

type Props=Omit<SelectHTMLAttributes<HTMLSelectElement>,'multiple'|'size'|'defaultValue'> & {value:string|number;'aria-label':string};
const text=(node:ReactNode):string=>Children.toArray(node).map(child=>isValidElement<{children?:ReactNode}>(child)?text(child.props.children):String(child)).join('');

/** One themed select-only combobox. The native control retains form/change semantics only. */
export function Select({children,value,disabled,id:providedId,className,'aria-label':label,'aria-describedby':description,...props}:Props){
 const generated=useId(),id=providedId??generated;
 const wrapper=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),native=useRef<HTMLSelectElement>(null),menu=useRef<HTMLDivElement>(null);
 const [open,setOpen]=useState(false),[active,setActive]=useState(-1);
 const search=useRef({text:'',time:0});
 const options=useMemo(()=>Children.toArray(children).flatMap(child=>{
  if(!isValidElement<{value?:string|number;disabled?:boolean;children?:ReactNode}>(child)||child.type!=='option')return [];
  const label=text(child.props.children);return [{value:String(child.props.value??label),label,disabled:!!child.props.disabled}];
 }),[children]);
 const selected=options.findIndex(option=>option.value===String(value));
 const available=options.map((option,index)=>option.disabled?-1:index).filter(index=>index>=0);
 const expanded=open&&!disabled;
 useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
 function show(index=selected){if(disabled)return;setActive(available.includes(index)?index:available[0]??-1);setOpen(true);}
 function choose(index:number){
  const option=options[index];if(!option||option.disabled||disabled)return;
  setOpen(false);trigger.current?.focus({preventScroll:true});
  if(native.current&&option.value!==String(value)){
   native.current.value=option.value;
   native.current.dispatchEvent(new Event('change',{bubbles:true}));
  }
 }
 function key(event:KeyboardEvent<HTMLButtonElement>){
  if(event.isDefaultPrevented()||event.nativeEvent.isComposing)return;
  if(event.key==='Escape'&&expanded){event.preventDefault();event.stopPropagation();setOpen(false);return;}
  if(event.key==='Tab'){setOpen(false);return;}
  if(event.key==='Enter'||event.key===' '){event.preventDefault();expanded?choose(active):show();return;}
  if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
   event.preventDefault();
   if(event.key==='Home'){show(available[0]);return;}if(event.key==='End'){show(available.at(-1));return;}
   if(!expanded){show(selected<0&&event.key==='ArrowUp'?available.at(-1):selected);return;}
   const position=available.indexOf(active),next=Math.max(0,Math.min(available.length-1,position+(event.key==='ArrowDown'?1:-1)));
   setActive(available[next]??-1);return;
  }
  if(event.key.length===1&&!event.ctrlKey&&!event.metaKey&&!event.altKey){
   event.preventDefault();const now=Date.now(),letter=event.key.toLocaleLowerCase();
   const prefix=now-search.current.time<700?search.current.text+letter:letter;
   search.current={text:prefix,time:now};
   const query=[...prefix].every(char=>char===letter)?letter:prefix;
   const start=query.length===1?(expanded?active:selected)+1:Math.max(0,active);
   const ordered=[...options.keys()].slice(start).concat([...options.keys()].slice(0,start));
   const match=ordered.find(index=>!options[index].disabled&&options[index].label.toLocaleLowerCase().startsWith(query));
   if(match!==undefined)show(match);
  }
 }
 useLayoutEffect(()=>{
  const panel=menu.current,button=trigger.current;if(!expanded||!panel||!button)return;
  function place(){
   if(!panel||!button)return;
   const rect=button.getBoundingClientRect(),viewport=window.visualViewport;
   const x=viewport?.offsetLeft??0,y=viewport?.offsetTop??0,w=viewport?.width??innerWidth,h=viewport?.height??innerHeight;
   const width=Math.min(rect.width,w-16),below=y+h-rect.bottom-14,above=rect.top-y-14;
   const upwards=below<Math.min(240,panel.scrollHeight)&&above>below;
   panel.style.width=width+'px';panel.style.maxHeight=Math.max(40,Math.min(288,upwards?above:below))+'px';
   panel.style.left=Math.max(x+8,Math.min(rect.left,x+w-width-8))+'px';
   panel.style.top=(upwards?rect.top-6-panel.getBoundingClientRect().height:rect.bottom+6)+'px';
  }
  panel.showPopover();place();
  const outside=(event:PointerEvent)=>{if(!wrapper.current?.contains(event.target as Node))setOpen(false);};
  const scroll=(event:Event)=>{if(!panel.contains(event.target as Node))place();};
  const observer=new ResizeObserver(place);observer.observe(button);
  document.addEventListener('pointerdown',outside,true);window.addEventListener('resize',place);window.addEventListener('scroll',scroll,true);
  window.visualViewport?.addEventListener('resize',place);window.visualViewport?.addEventListener('scroll',place);
  return()=>{observer.disconnect();document.removeEventListener('pointerdown',outside,true);window.removeEventListener('resize',place);window.removeEventListener('scroll',scroll,true);window.visualViewport?.removeEventListener('resize',place);window.visualViewport?.removeEventListener('scroll',place);if(panel.matches(':popover-open'))panel.hidePopover();};
 },[expanded,options.length]);
 useLayoutEffect(()=>{if(expanded)menu.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({block:'nearest'});},[expanded,active]);
 return <div ref={wrapper} className={[styles.root,className].filter(Boolean).join(' ')} data-select-root>
  <button ref={trigger} id={id} type="button" role="combobox" aria-label={label} aria-describedby={description} aria-required={props.required} aria-invalid={props['aria-invalid']} aria-expanded={expanded} aria-controls={expanded?id+'-list':undefined} aria-haspopup="listbox" aria-activedescendant={expanded&&active>=0?id+'-option-'+active:undefined} disabled={disabled}
   className={styles.trigger} onClick={()=>expanded?setOpen(false):show()} onKeyDown={key} onBlur={()=>setOpen(false)}>
   <span className={styles.value} data-placeholder={selected<0||options[selected]?.value===''}>{options[selected]?.label??'请选择'}</span><ChevronDown size={16} className={styles.arrow} aria-hidden="true"/>
  </button>
  <select {...props} ref={native} id={id+'-native'} value={value} disabled={disabled} aria-hidden="true" tabIndex={-1} hidden style={{display:'none'}}>{children}</select>
  {expanded&&<div ref={menu} id={id+'-list'} popover="manual" role="listbox" aria-label={label} className={styles.menu} onMouseDown={event=>event.preventDefault()} onClick={event=>{event.preventDefault();event.stopPropagation();}}>
   {options.length?options.map((option,index)=><div key={option.value} id={id+'-option-'+index} role="option" aria-selected={index===selected} aria-disabled={option.disabled||undefined} data-active={index===active} className={styles.option}
    onPointerMove={()=>{if(!option.disabled)setActive(index);}} onClick={()=>choose(index)}><span>{option.label}</span>{index===selected&&<Check size={16} aria-hidden="true"/>}</div>):<div className={styles.empty}>暂无可选项</div>}
  </div>}
 </div>;
}
