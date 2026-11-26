import {restoreDialogFocus} from './focus.ts';
import {tabStops,focusTabStop,MODAL_KEYBOARD_EVENT} from './focus-navigation.ts';

/** Own focus, inertness and listeners for one visible modal activation only. */
export function activateModal(doc:Document,panel:()=>HTMLElement|null,close:()=>HTMLElement|null,requestClose:()=>void) {
  const before=doc.activeElement instanceof HTMLElement?doc.activeElement:null;
  let keyboard=!!before?.matches(':focus-visible')&&!before.hasAttribute('data-pointer-focus');
  const pointer=()=>{keyboard=false;};
  const root=doc.getElementById('root');
  const wasInert=root?.inert??false;
  if(root)root.inert=true;
  close()?.focus({preventScroll:true});
  const currentPanel=panel(),forwardedKey=()=>{keyboard=true;};
  currentPanel?.addEventListener(MODAL_KEYBOARD_EVENT,forwardedKey);
  function key(event:KeyboardEvent) {
    keyboard=true;
    if(event.defaultPrevented||event.isComposing)return;
    if(event.key==='Escape'){event.preventDefault();requestClose();return;}
    if(event.key!=='Tab')return;
    const currentPanel=panel(),items=currentPanel?tabStops(currentPanel):[];
    if(!items.length){event.preventDefault();return;}
    const index=items.indexOf(doc.activeElement as HTMLElement);
    if(index<0)return;
    const next=items[(index+(event.shiftKey?-1:1)+items.length)%items.length];
    if((event.shiftKey&&index===0)||(!event.shiftKey&&index===items.length-1)||next.tagName==='IFRAME'){
      event.preventDefault();focusTabStop(next,event.shiftKey?'last':'first');
    }
  }
  doc.addEventListener('keydown',key);
  doc.addEventListener('pointerdown',pointer,true);
  return()=>{
    currentPanel?.removeEventListener(MODAL_KEYBOARD_EVENT,forwardedKey);
    doc.removeEventListener('keydown',key);
    doc.removeEventListener('pointerdown',pointer,true);
    if(root)root.inert=wasInert;
    if(before)restoreDialogFocus(before,keyboard);
  };
}
