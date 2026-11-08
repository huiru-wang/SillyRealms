import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MessageContent} from '../src/message-content';
import {StoryContext,type MessageComponent,type StoryConfiguration} from '../src/story-context';

const checks:Array<{name:string;pass:boolean}>=[];
const check=(name:string,pass:unknown)=>checks.push({name,pass:!!pass});
const wait=()=>new Promise(resolve=>setTimeout(resolve,180));
const rule={id:'dice',roles:['assistant' as const],pattern:'DICE',replacement:{type:'component' as const,component:'Dice'}};
const Dice:MessageComponent=()=>{const [count,setCount]=useState(0);return <button id="dice" onClick={()=>setCount(n=>n+1)}>count:{count}</button>};
Dice.srDisplay='inline';
const config:StoryConfiguration={rules:[rule],components:{Dice},state:{},ready:()=>{},match:async text=>{if(text.includes('FAIL'))throw Error('failure');const start=text.indexOf('DICE');return {warning:false,matches:start<0?[]:[{start,end:start+4,ruleId:'dice',replacement:rule.replacement,match:'DICE',groups:[],namedGroups:{}}]}}};
const root=createRoot(document.querySelector('#root')!);
const show=(text:string,configuration=config)=>root.render(<StoryContext.Provider value={configuration}><MessageContent message={{id:'m',role:'assistant',text}} runId="r"/></StoryContext.Provider>);
async function run(){
  show('开始 DICE');await wait();
  const button=document.querySelector<HTMLButtonElement>('#dice');const slot=button?.closest('[data-sr-slot]');
  check('matched component mounts in a slot',!!slot&&button?.textContent==='count:0');
  button?.click();await wait();
  check('component interaction updates state',button?.textContent==='count:1');
  show('开始 DICE，流式追加');await wait();
  check('streaming update preserves slot and component state',document.querySelector('#dice')?.closest('[data-sr-slot]')===slot&&document.querySelector('#dice')?.textContent==='count:1'&&document.querySelector('#root')?.textContent?.includes('流式追加'));
  show('开始 DICE，流式追加更多');await wait();
  check('successive updates retain slot identity',document.querySelector('#dice')?.closest('[data-sr-slot]')===slot&&document.querySelector('#dice')?.textContent==='count:1');
  show('FAIL **原文**');await wait();
  check('matcher failure falls back with original text and warning',!!document.querySelector('[role="status"]')&&!!document.querySelector('#root')?.textContent?.includes('FAIL')&&!document.querySelector('#dice'));
  const missing:StoryConfiguration={...config,components:{}};
  show('开始 DICE',missing);await wait();
  check('missing component keeps original text and reports warning',!!document.querySelector('#root')?.textContent?.includes('DICE')&&!!document.querySelector('#root')?.textContent?.includes('组件不可用'));
  root.unmount();document.querySelector('#results')!.textContent=JSON.stringify(checks,null,2);document.title=checks.every(x=>x.pass)?'PASS':'FAIL';
}
void run().catch(error=>{document.title='FAIL';document.querySelector('#results')!.textContent=String(error)});
