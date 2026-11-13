import React from 'react';
import {createRoot} from 'react-dom/client';
import {WorldDocumentRenderer} from '../src/world-document/WorldDocumentRenderer';
const checks:Array<{name:string;pass:boolean}>=[];
const wait=()=>new Promise(resolve=>setTimeout(resolve,250));
const root=createRoot(document.querySelector('#root')!);
const filtered='<!doctype html><html><head><style>.card{color:red;background-image:url(https://evil.test/a);position:fixed}@import url(https://evil.test/a)</style></head><body><div class="card">内容</div></body></html>';
root.render(<><div className="plain"><WorldDocumentRenderer title="plain" content="普通文本"/></div><div className="card"><WorldDocumentRenderer title="card" content="开局文本"/></div><div id="warning-default"><WorldDocumentRenderer title="default-warning" content={filtered}/></div><div id="warning-hidden"><WorldDocumentRenderer title="hidden-warning" content={filtered} showStyleWarning={false}/></div></>);
async function run(){
  await wait();
  checks.push({name:'filtered-style notice can be hidden without changing the default',pass:!!document.querySelector('#warning-default [role=status]')&&!document.querySelector('#warning-hidden [role=status]')});
  const hidden=document.querySelector<HTMLIFrameElement>('iframe[title="hidden-warning"]');
  checks.push({name:'hidden notice still keeps dangerous styles filtered and the iframe scriptless',pass:!!hidden&&!hidden.srcdoc.includes('position:fixed')&&!hidden.sandbox.contains('allow-scripts')});
  const read=(title:string)=>{const doc=document.querySelector<HTMLIFrameElement>(`iframe[title=${title}]`)?.contentDocument;return doc?.body?{color:getComputedStyle(doc.body).color,bg:getComputedStyle(doc.body).backgroundColor}:null};
  let plain=read('plain'),card=read('card');
  checks.push({name:'light theme matches surrounding page and card',pass:plain?.bg==='rgb(247, 248, 251)'&&card?.bg==='rgb(255, 255, 255)'&&plain.color==='rgb(32, 36, 52)'});
  document.documentElement.dataset.theme='dark';await wait();
  plain=read('plain');card=read('card');
  checks.push({name:'dark theme updates readable text and both backgrounds',pass:plain?.bg==='rgb(21, 24, 32)'&&card?.bg==='rgb(32, 36, 46)'&&plain.color==='rgb(238, 240, 246)'});
  document.documentElement.dataset.theme='light';await wait();
  plain=read('plain');card=read('card');
  checks.push({name:'switching back restores light theme',pass:plain?.bg==='rgb(247, 248, 251)'&&card?.bg==='rgb(255, 255, 255)'&&plain.color==='rgb(32, 36, 52)'});
  root.unmount();document.querySelector('#results')!.textContent=JSON.stringify(checks,null,2);document.title=checks.every(c=>c.pass)?'PASS':'FAIL';
}
void run();
