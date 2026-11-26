import {leaveModalFrame,tabStops,MODAL_KEYBOARD_EVENT,type FocusEdge} from '../../components/ui/focus-navigation.ts';

type Packet={type:string;[key:string]:unknown};
const packet=(value:unknown):value is Packet=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&typeof (value as Packet).type==='string';
const generation=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const edge=(value:unknown):value is FocusEdge=>value==='first'||value==='last';

/** UI-only messages on the already authenticated preview MessagePort. */
export function createPreviewDialogHost(options:{
  frame:()=>HTMLIFrameElement|null;enabled:()=>boolean;active:()=>boolean;send:(message:Packet)=>void;
}) {
  let epoch=0,enabled=false,disposed=false;
  function current(){
    const next=!disposed&&options.enabled()&&options.active();
    if(next!==enabled){enabled=next;epoch++;}
    return next;
  }
  function focusedFrame(){
    const frame=options.frame();
    return current()&&frame&&frame.ownerDocument.activeElement===frame&&!frame.closest('[inert]')&&
      frame.closest('[role="dialog"][aria-modal="true"]')?frame:null;
  }
  return {
    sync(){const active=current();options.send({type:'preview-dialog',active,generation:epoch});},
    receive(value:unknown):boolean {
      if(!packet(value)||value.type!=='preview-dialog-key')return false;
      const frame=focusedFrame();
      if(!frame||!generation(value.generation)||value.generation!==epoch)return true;
      if(value.key==='Escape'&&Object.keys(value).every(key=>['type','generation','key'].includes(key))){
        const panel=frame.closest('[role="dialog"]');
        panel?.dispatchEvent(new Event(MODAL_KEYBOARD_EVENT));
        panel?.querySelector<HTMLButtonElement>('[data-modal-close]')?.click();
      } else if(value.key==='Tab'&&(value.direction==='forward'||value.direction==='backward')&&Object.keys(value).every(key=>['type','generation','key','direction'].includes(key))){
        frame.closest('[role="dialog"]')?.dispatchEvent(new Event(MODAL_KEYBOARD_EVENT));
        leaveModalFrame(frame,value.direction);
      }
      return true;
    },
    focus(value:unknown){
      if(!edge(value)||!focusedFrame())return;
      options.send({type:'preview-dialog-focus',edge:value,generation:epoch});
    },
    dispose(){disposed=true;current();},
  };
}

/** The child document owns its tab boundaries; ordinary previews never enable this. */
export function createPreviewDialogFrame(doc:Document,send:(message:Packet)=>void,active:()=>boolean) {
  let enabled=false,epoch=0,disposed=false,listening=false;
  const current=()=>!disposed&&enabled&&active()&&!doc.hidden;
  const key=(event:KeyboardEvent)=>{
    if(!current()||event.defaultPrevented||event.isComposing)return;
    if(event.key==='Escape'){
      event.preventDefault();send({type:'preview-dialog-key',key:'Escape',generation:epoch});return;
    }
    if(event.key!=='Tab'||event.altKey||event.ctrlKey||event.metaKey)return;
    const items=tabStops(doc),at=doc.activeElement;
    if(!items.length||(event.shiftKey?at===items[0]:at===items[items.length-1])){
      event.preventDefault();send({type:'preview-dialog-key',key:'Tab',direction:event.shiftKey?'backward':'forward',generation:epoch});
    }
  };
  function listen(){
    if(enabled&&!disposed&&!listening){doc.addEventListener('keydown',key);listening=true;}
    else if((!enabled||disposed)&&listening){doc.removeEventListener('keydown',key);listening=false;}
  }
  return {
    receive(value:unknown):boolean {
      if(!packet(value))return false;
      if(value.type==='preview-dialog'){
        if(typeof value.active==='boolean'&&generation(value.generation)){
          enabled=value.active;epoch=value.generation;listen();
        }
        return true;
      }
      if(value.type!=='preview-dialog-focus')return false;
      if(!current()||value.generation!==epoch||!edge(value.edge))return true;
      const items=tabStops(doc),target=value.edge==='first'?items[0]:items[items.length-1];
      if(target)target.focus({preventScroll:true});
      else {doc.body.tabIndex=-1;doc.body.focus({preventScroll:true});}
      return true;
    },
    dispose(){disposed=true;listen();},
  };
}
