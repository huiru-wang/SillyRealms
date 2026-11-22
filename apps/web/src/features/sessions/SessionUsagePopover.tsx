import {useLayoutEffect,useRef,type ReactNode,type RefObject} from 'react';
import {createPortal} from 'react-dom';
import {restoreDialogFocus} from '../../components/ui/focus';

/** The transparent layer also catches outside clicks over the isolated story iframe. */
export function SessionUsagePopover({id,anchor,onClose,children}:{
  id:string;anchor:RefObject<HTMLButtonElement|null>;onClose:()=>void;children:ReactNode;
}){
  const panel=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{
    const element=panel.current,trigger=anchor.current;if(!element||!trigger)return;
    const visual=window.visualViewport;
    const place=()=>{
      const bounds=trigger.getBoundingClientRect(),edge=12;
      const left=visual?.offsetLeft??0,top=visual?.offsetTop??0;
      const width=visual?.width??window.innerWidth,height=visual?.height??window.innerHeight;
      const panelWidth=Math.min(560,Math.max(0,width-edge*2)),panelTop=Math.max(top+edge,bounds.bottom+4);
      element.style.width=panelWidth+'px';
      element.style.left=Math.max(left+edge,Math.min(bounds.right-panelWidth,left+width-edge-panelWidth))+'px';
      element.style.top=panelTop+'px';
      element.style.maxHeight=Math.max(0,top+height-panelTop-edge)+'px';
    };
    place();element.focus({preventScroll:true});
    const observer=new ResizeObserver(place);observer.observe(trigger);
    const actions=trigger.closest('.host-usage')?.parentElement,toolbar=trigger.closest('[data-session-toolbar]');
    if(actions)observer.observe(actions);
    if(toolbar)observer.observe(toolbar);
    window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    visual?.addEventListener('resize',place);visual?.addEventListener('scroll',place);
    return()=>{
      observer.disconnect();window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);
      visual?.removeEventListener('resize',place);visual?.removeEventListener('scroll',place);
    };
  },[anchor]);
  const dismiss=(keyboard:boolean)=>{onClose();if(anchor.current)restoreDialogFocus(anchor.current,keyboard);};
  return createPortal(<div className="host-usage-layer" onPointerDown={event=>{
    if(event.target===event.currentTarget){event.preventDefault();dismiss(false);}
  }}>
    <div ref={panel} id={id} className="host-usage-content" role="region" aria-label="Token 用量详情" tabIndex={-1}
      onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();dismiss(true);}}}
      onBlur={event=>{if(event.relatedTarget&&!event.currentTarget.contains(event.relatedTarget))onClose();}}>
      {children}
    </div>
  </div>,document.body);
}
