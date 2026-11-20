import {useEffect,useLayoutEffect,useRef,useState} from 'react';
/** Visual viewport and composer occlusion are local layout, independent of session data. */
export function useSessionLayout(){
  const detail=useRef<HTMLElement>(null),composer=useRef<HTMLDivElement>(null),overlay=useRef<HTMLDivElement>(null),viewport=useRef<HTMLDivElement>(null);
  const [bottomInset,setBottomInset]=useState(0);
  useEffect(()=>{
    const visual=window.visualViewport;
    const update=()=>{const element=detail.current;if(!element)return;
      if(visual&&window.innerWidth<=760&&visual.scale===1)element.style.setProperty('--session-viewport-height',Math.min(window.innerHeight,visual.height+visual.offsetTop)+'px');
      else element.style.removeProperty('--session-viewport-height');};
    update();visual?.addEventListener('resize',update);visual?.addEventListener('scroll',update);window.addEventListener('resize',update);
    return()=>{visual?.removeEventListener('resize',update);visual?.removeEventListener('scroll',update);window.removeEventListener('resize',update);};
  },[]);
  useLayoutEffect(()=>{
    const cover=overlay.current,stage=viewport.current;if(!cover||!stage)return;
    let pending:number|undefined;
    const measure=()=>{pending=undefined;const bounds=stage.getBoundingClientRect(),input=composer.current?.querySelector<HTMLElement>('.sr-composer-editor');
      if(input){const chrome=cover.getBoundingClientRect().height-input.getBoundingClientRect().height;cover.style.setProperty('--composer-editor-room',Math.max(44,Math.floor(bounds.height-96-chrome))+'px');}
      const inset=Math.max(0,Math.min(800,bounds.height,Math.ceil(bounds.bottom-cover.getBoundingClientRect().top)));setBottomInset(value=>value===inset?value:inset);};
    const observer=new ResizeObserver(()=>{if(pending===undefined)pending=requestAnimationFrame(measure);});observer.observe(cover);observer.observe(stage);measure();
    return()=>{observer.disconnect();if(pending!==undefined)cancelAnimationFrame(pending);};
  },[]);
  return {detail,composer,overlay,viewport,bottomInset};
}
