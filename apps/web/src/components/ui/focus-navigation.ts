export const PREVIEW_FOCUS_EVENT='sr-preview-focus';
export const MODAL_KEYBOARD_EVENT='sr-modal-keyboard';
export type FocusEdge='first'|'last';

/** Native tab order for visible controls in this document or modal. */
export function tabStops(root:ParentNode):HTMLElement[] {
  const items=Array.from(root.querySelectorAll<HTMLElement>('a[href],area[href],button,input,select,textarea,iframe,summary,[tabindex],[contenteditable],audio[controls],video[controls]'))
    .filter(element=>element.tabIndex>=0&&!element.matches(':disabled')&&!element.closest('[inert]')&&element.getClientRects().length>0&&getComputedStyle(element).visibility!=='hidden');
  const radio=(element:HTMLElement)=>element.tagName==='INPUT'&&(element as HTMLInputElement).type==='radio'&&(element as HTMLInputElement).name;
  return items.filter(element=>{
    if(!radio(element))return true;
    const input=element as HTMLInputElement;
    const group=items.filter(other=>radio(other)&&(other as HTMLInputElement).name===input.name&&(other as HTMLInputElement).form===input.form) as HTMLInputElement[];
    return element===(group.find(other=>other.checked)??group[0]);
  }).sort((left,right)=>{
    const a=left.tabIndex,b=right.tabIndex;
    return a===b?0:a===0?1:b===0?-1:a-b;
  });
}

/** A preview iframe must explicitly focus its first/last child control. */
export function focusTabStop(element:HTMLElement,edge:FocusEdge) {
  element.focus({preventScroll:true});
  if(element.tagName==='IFRAME')element.dispatchEvent(new CustomEvent(PREVIEW_FOCUS_EVENT,{detail:{edge}}));
}

export function leaveModalFrame(frame:HTMLIFrameElement,direction:'forward'|'backward'):boolean {
  const panel=frame.closest('[role="dialog"][aria-modal="true"]');
  if(!panel)return false;
  const items=tabStops(panel),index=items.indexOf(frame);
  if(index<0||items.length<2)return false;
  const next=items[(index+(direction==='forward'?1:-1)+items.length)%items.length];
  focusTabStop(next,direction==='forward'?'first':'last');
  return true;
}
