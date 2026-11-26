import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activateModal} from '../src/components/ui/modal-interaction.ts';

// Bounded DOM ports exercise the actual focus/listener owner without a browser
// or an application mock. React keeps the portal independently of activation.
function fixture(t){
  class Target extends EventTarget {
    listeners=new Map();
    addEventListener(type,listener,options){super.addEventListener(type,listener,options);let set=this.listeners.get(type);if(!set)this.listeners.set(type,set=new Set());set.add(listener);}
    removeEventListener(type,listener,options){super.removeEventListener(type,listener,options);this.listeners.get(type)?.delete(listener);}
  }
  const doc=new Target();
  class Element extends Target {
    attributes=new Map();inert=false;tabIndex=0;isConnected=true;visible=true;focusVisible=false;tagName='BUTTON';
    focus(){doc.activeElement=this;}
    matches(selector){return selector===':focus-visible'&&this.focusVisible;}
    hasAttribute(key){return this.attributes.has(key);}
    setAttribute(key,value){this.attributes.set(key,value);}
    removeAttribute(key){this.attributes.delete(key);}
    getClientRects(){return this.visible?[{}]:[];}
    closest(){return this.inert?this:null;}
  }
  const oldElement=globalThis.HTMLElement,oldStyle=globalThis.getComputedStyle;
  globalThis.HTMLElement=Element;globalThis.getComputedStyle=()=>({visibility:'visible'});
  t.after(()=>{if(oldElement===undefined)delete globalThis.HTMLElement;else globalThis.HTMLElement=oldElement;if(oldStyle===undefined)delete globalThis.getComputedStyle;else globalThis.getComputedStyle=oldStyle;});
  const root=new Element(),trigger=new Element(),close=new Element(),frame=new Element(),hidden=new Element();hidden.visible=false;
  frame.tagName='IFRAME';
  let selector;const panel=new Element();panel.querySelectorAll=value=>{selector=value;return [close,frame,hidden];};
  doc.activeElement=trigger;doc.getElementById=id=>id==='root'?root:null;
  const key=(value,fields={})=>{const event=new Event('keydown',{cancelable:true});Object.assign(event,{key:value,isComposing:false,shiftKey:false,...fields});doc.dispatchEvent(event);return event;};
  return {doc,root,trigger,close,frame,panel,key,selector:()=>selector};
}

test('visible modal traps focus including the author iframe and releases Escape/focus/inert when hidden',t=>{
  const x=fixture(t);let closes=0;
  const open=()=>activateModal(x.doc,()=>x.panel,()=>x.close,()=>closes++);
  let dispose=open();
  assert.equal(x.root.inert,true);assert.equal(x.doc.activeElement,x.close);
  assert.equal(x.key('Tab',{shiftKey:true}).defaultPrevented,true);
  assert.equal(x.doc.activeElement,x.frame);assert.match(x.selector(),/iframe/);
  x.key('Tab');assert.equal(x.doc.activeElement,x.close);
  x.key('Escape');assert.equal(closes,1);
  dispose();
  assert.equal(x.root.inert,false);assert.equal(x.doc.activeElement,x.trigger);
  assert.equal(x.doc.listeners.get('keydown').size,0);assert.equal(x.doc.listeners.get('pointerdown').size,0);
  x.key('Escape');assert.equal(closes,1);
  dispose=open();x.key('Escape');assert.equal(closes,2);
  assert.equal(x.doc.listeners.get('keydown').size,1);
  dispose();assert.equal(x.root.inert,false);
});

test('switching or evicting a retained dialog releases ownership before another activation',t=>{
  const x=fixture(t);let first=0,second=0;
  const disposeFirst=activateModal(x.doc,()=>x.panel,()=>x.close,()=>first++);
  disposeFirst();
  const disposeSecond=activateModal(x.doc,()=>x.panel,()=>x.close,()=>second++);
  x.key('Escape');assert.equal(first,0);assert.equal(second,1);
  x.trigger.isConnected=false;
  disposeSecond();assert.equal(x.root.inert,false);assert.equal(x.doc.listeners.get('keydown').size,0);
  x.key('Escape');assert.equal(second,1);
});

test('cleanup preserves an inert root owned by an outer dialog',t=>{
  const x=fixture(t);x.root.inert=true;
  const dispose=activateModal(x.doc,()=>x.panel,()=>x.close,()=>{});
  dispose();assert.equal(x.root.inert,true);
});
