import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MessageChannel} from 'node:worker_threads';
import {createPreviewDialogHost,createPreviewDialogFrame} from '../src/features/worlds/preview-dialog.ts';
import {activateModal} from '../src/components/ui/modal-interaction.ts';
import {PREVIEW_FOCUS_EVENT} from '../src/components/ui/focus-navigation.ts';

// These bounded DOM ports represent separate host/child documents. Keyboard
// events originate in the child; the actual MessageChannel crosses the boundary.
class Target extends EventTarget {
  listeners=new Map();
  addEventListener(type,listener,options){super.addEventListener(type,listener,options);let set=this.listeners.get(type);if(!set)this.listeners.set(type,set=new Set());set.add(listener);}
  removeEventListener(type,listener,options){super.removeEventListener(type,listener,options);this.listeners.get(type)?.delete(listener);}
}
class Element extends Target {
  attributes=new Map();inert=false;tabIndex=0;isConnected=true;visible=true;visibility='visible';disabled=false;focusVisible=false;children=[];
  constructor(doc,tagName='BUTTON',parent=null){super();this.ownerDocument=doc;this.tagName=tagName;this.parent=parent;if(parent)parent.children.push(this);}
  focus(){this.ownerDocument.activeElement=this;this.ownerDocument.onFocus?.();}
  click(){this.dispatchEvent(new Event('click'));}
  matches(selector){return selector===':disabled'?this.disabled:selector===':focus-visible'&&this.focusVisible;}
  hasAttribute(key){return this.attributes.has(key);}
  setAttribute(key,value){this.attributes.set(key,value);}
  removeAttribute(key){this.attributes.delete(key);}
  getClientRects(){return this.visible?[{}]:[];}
  closest(selector){
    for(let item=this;item;item=item.parent){
      if(selector==='[inert]'&&item.inert)return item;
      if(selector==='[role="dialog"]'&&item.role==='dialog')return item;
      if(selector==='[role="dialog"][aria-modal="true"]'&&item.role==='dialog'&&item.ariaModal)return item;
    }
    return null;
  }
  querySelectorAll(){return this.children.flatMap(item=>[item,...item.querySelectorAll()]);}
  querySelector(selector){return selector==='[data-modal-close]'?this.querySelectorAll().find(item=>item.hasAttribute('data-modal-close'))??null:null;}
}
class Doc extends Target {
  hidden=false;
  constructor(){super();this.body=new Element(this,'BODY');this.body.tabIndex=-1;this.activeElement=this.body;}
  querySelectorAll(){return this.body.querySelectorAll();}
  getElementById(id){return id==='root'?this.root:null;}
}
const key=(doc,value,fields={})=>{
  const event=new Event('keydown',{cancelable:true});
  Object.assign(event,{key:value,isComposing:false,shiftKey:false,altKey:false,ctrlKey:false,metaKey:false,...fields});
  doc.dispatchEvent(event);return event;
};
function fixture(t,{dialog=true,active=true,controls=3}={}){
  const oldElement=globalThis.HTMLElement,oldStyle=globalThis.getComputedStyle;
  globalThis.HTMLElement=Element;globalThis.getComputedStyle=element=>({visibility:element.visibility});
  const hostDoc=new Doc(),childDoc=new Doc();
  const root=hostDoc.root=new Element(hostDoc,'MAIN',hostDoc.body);
  const trigger=new Element(hostDoc,'BUTTON',root);hostDoc.activeElement=trigger;
  const panel=new Element(hostDoc,'SECTION',hostDoc.body);panel.tabIndex=-1;panel.role='dialog';panel.ariaModal=true;
  const close=new Element(hostDoc,'BUTTON',panel);close.setAttribute('data-modal-close','');
  const frame=new Element(hostDoc,'IFRAME',panel);
  const inputs=Array.from({length:controls},()=>new Element(childDoc,'BUTTON',childDoc.body));
  childDoc.onFocus=()=>{hostDoc.activeElement=frame;};
  const state={dialog,active,childActive:active,closes:0};
  close.addEventListener('click',()=>state.closes++);
  const channel=new MessageChannel(),sent=[],received=[],pending=new Map();let sequence=0;
  const host=createPreviewDialogHost({frame:()=>frame,enabled:()=>state.dialog,active:()=>state.active,send:data=>channel.port1.postMessage(data)});
  const child=createPreviewDialogFrame(childDoc,data=>channel.port2.postMessage(data),()=>state.childActive);
  channel.port1.on('message',data=>{
    if(data.type==='test-flush'){pending.get(data.id)?.();pending.delete(data.id);return;}
    received.push(data);host.receive(data);
  });
  channel.port2.on('message',data=>{
    if(data.type==='test-flush'){channel.port2.postMessage(data);return;}
    sent.push(data);child.receive(data);
  });
  frame.addEventListener(PREVIEW_FOCUS_EVENT,event=>host.focus(event.detail.edge));
  const flush=()=>new Promise(resolve=>{const id=++sequence;pending.set(id,resolve);channel.port1.postMessage({type:'test-flush',id});});
  const sync=async()=>{host.sync();await flush();};
  const disposals=new Set();
  const activate=()=>{
    const release=activateModal(hostDoc,()=>panel,()=>close,()=>state.closes++);
    const dispose=()=>{if(disposals.delete(dispose))release();};disposals.add(dispose);return dispose;
  };
  t.after(()=>{
    for(const dispose of disposals)dispose();
    host.dispose();child.dispose();channel.port1.close();channel.port2.close();
    if(oldElement===undefined)delete globalThis.HTMLElement;else globalThis.HTMLElement=oldElement;
    if(oldStyle===undefined)delete globalThis.getComputedStyle;else globalThis.getComputedStyle=oldStyle;
  });
  return {hostDoc,childDoc,root,trigger,panel,close,frame,inputs,state,host,child,sent,received,flush,sync,activate,
    generation:()=>sent.findLast(data=>data.type==='preview-dialog')?.generation,
    send:data=>channel.port2.postMessage(data)};
}

test('Escape travels from the child document through its port and preserves keyboard focus restoration',{timeout:5000},async t=>{
  const x=fixture(t);const deactivate=x.activate();await x.sync();
  x.inputs[1].focus();
  const event=key(x.childDoc,'Escape');await x.flush();
  assert.equal(event.defaultPrevented,true);assert.equal(x.state.closes,1);
  assert.deepEqual(x.received,[{type:'preview-dialog-key',key:'Escape',generation:x.generation()}]);
  assert.equal(x.hostDoc.activeElement,x.frame);
  deactivate();
  assert.equal(x.hostDoc.activeElement,x.trigger);assert.equal(x.trigger.hasAttribute('data-pointer-focus'),false);
  assert.equal(x.root.inert,false);
});

test('Tab and Shift+Tab cycle host close and child first/last controls across real ports',{timeout:5000},async t=>{
  const x=fixture(t);x.activate();await x.sync();
  assert.equal(key(x.hostDoc,'Tab').defaultPrevented,true);await x.flush();
  assert.equal(x.hostDoc.activeElement,x.frame);assert.equal(x.childDoc.activeElement,x.inputs[0]);
  assert.equal(key(x.childDoc,'Tab',{shiftKey:true}).defaultPrevented,true);await x.flush();
  assert.equal(x.hostDoc.activeElement,x.close);
  assert.equal(key(x.hostDoc,'Tab',{shiftKey:true}).defaultPrevented,true);await x.flush();
  assert.equal(x.childDoc.activeElement,x.inputs[2]);
  assert.equal(key(x.childDoc,'Tab').defaultPrevented,true);await x.flush();
  assert.equal(x.hostDoc.activeElement,x.close);
  assert.deepEqual(x.received.map(data=>[data.key,data.direction]),[['Tab','backward'],['Tab','forward']]);
  assert.deepEqual(x.sent.filter(data=>data.type==='preview-dialog-focus').map(data=>data.edge),['first','last']);
  x.inputs[1].focus();
  assert.equal(key(x.childDoc,'Tab').defaultPrevented,false);await x.flush();
  assert.equal(x.hostDoc.activeElement,x.frame);assert.equal(x.received.length,2);
});

test('a component with no controls can still return focus to the host close button',{timeout:5000},async t=>{
  const x=fixture(t,{controls:0});x.activate();await x.sync();
  key(x.hostDoc,'Tab');await x.flush();
  assert.equal(x.childDoc.activeElement,x.childDoc.body);
  key(x.childDoc,'Tab');await x.flush();
  assert.equal(x.hostDoc.activeElement,x.close);
  key(x.hostDoc,'Tab',{shiftKey:true});await x.flush();
  key(x.childDoc,'Tab',{shiftKey:true});await x.flush();
  assert.equal(x.hostDoc.activeElement,x.close);
});

test('the child respects handled keys, composition, hidden documents and paused activity',{timeout:5000},async t=>{
  const x=fixture(t);x.activate();await x.sync();x.inputs[2].focus();
  const prevented=new Event('keydown',{cancelable:true});Object.assign(prevented,{key:'Escape'});prevented.preventDefault();x.childDoc.dispatchEvent(prevented);
  key(x.childDoc,'Escape',{isComposing:true});key(x.childDoc,'Tab',{ctrlKey:true});
  x.childDoc.hidden=true;key(x.childDoc,'Escape');x.childDoc.hidden=false;
  x.state.childActive=false;key(x.childDoc,'Escape');await x.flush();
  assert.equal(x.received.length,0);assert.equal(x.state.closes,0);
});

for(const mode of ['ordinary preview','hidden cached dialog']){
  test(mode+' rejects child keys and direct port notifications',{timeout:5000},async t=>{
    const x=fixture(t,{dialog:mode!=='ordinary preview',active:mode!=='hidden cached dialog'});
    await x.sync();x.inputs[2].focus();
    assert.equal(key(x.childDoc,'Escape').defaultPrevented,false);
    assert.equal(x.childDoc.listeners.get('keydown')?.size??0,0);
    x.send({type:'preview-dialog-key',key:'Escape',generation:x.generation()});
    x.send({type:'preview-dialog-key',key:'Tab',direction:'forward',generation:x.generation()});
    await x.flush();
    assert.equal(x.state.closes,0);assert.equal(x.hostDoc.activeElement,x.frame);
  });
}

test('another focused frame, an inert dialog and a removed dialog role cannot receive host effects',{timeout:5000},async t=>{
  const x=fixture(t);x.activate();await x.sync();x.inputs[2].focus();
  const other=new Element(x.hostDoc,'IFRAME',x.hostDoc.body);other.focus();
  const send=()=>{x.send({type:'preview-dialog-key',key:'Escape',generation:x.generation()});x.send({type:'preview-dialog-key',key:'Tab',direction:'forward',generation:x.generation()});};
  send();await x.flush();assert.equal(x.hostDoc.activeElement,other);
  x.frame.focus();x.panel.inert=true;send();await x.flush();assert.equal(x.hostDoc.activeElement,x.frame);
  x.panel.inert=false;x.panel.role=undefined;send();await x.flush();
  assert.equal(x.state.closes,0);assert.equal(x.hostDoc.activeElement,x.frame);
});

test('strict messages and activation generations reject malformed and previously queued child keys',{timeout:5000},async t=>{
  const x=fixture(t);x.activate();await x.sync();x.inputs[2].focus();const old=x.generation();
  for(const data of [
    {key:'Enter'}, {key:'Tab',direction:'sideways'}, {key:'Escape',method:'state.write'},
    {key:'Tab',direction:'forward',extra:true}, {key:'Escape',generation:String(old)},
  ])x.send({type:'preview-dialog-key',generation:old,...data});
  await x.flush();assert.equal(x.state.closes,0);assert.equal(x.hostDoc.activeElement,x.frame);
  x.state.active=false;await x.sync();assert.equal(x.childDoc.listeners.get('keydown').size,0);
  x.state.active=true;await x.sync();assert.notEqual(x.generation(),old);
  x.send({type:'preview-dialog-key',key:'Escape',generation:old});
  x.send({type:'preview-dialog-key',key:'Tab',direction:'forward',generation:old});
  await x.flush();assert.equal(x.state.closes,0);assert.equal(x.hostDoc.activeElement,x.frame);
  key(x.childDoc,'Escape');await x.flush();assert.equal(x.state.closes,1);
});

test('focus commands ignore stale activation and disposal releases child keyboard ownership',{timeout:5000},async t=>{
  const x=fixture(t);x.activate();await x.sync();x.inputs[1].focus();
  x.child.receive({type:'preview-dialog-focus',edge:'last',generation:x.generation()+1});
  assert.equal(x.childDoc.activeElement,x.inputs[1]);
  x.child.dispose();assert.equal(x.childDoc.listeners.get('keydown').size,0);
  key(x.childDoc,'Escape');await x.flush();assert.equal(x.state.closes,0);
  x.host.dispose();
  x.send({type:'preview-dialog-key',key:'Escape',generation:x.generation()});await x.flush();
  assert.equal(x.state.closes,0);
});
