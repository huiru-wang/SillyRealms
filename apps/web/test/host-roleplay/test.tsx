import React from 'react';
import {createRoot} from 'react-dom/client';
import {SessionHost} from '../../src/host';
import '../../src/style.css';
import '../../src/design-system/tokens.css';
import '../../src/design-system/studio.css';
import '../../src/features/sessions/composer/roleplay-composer.css';

let stream: FakeEventSource; let calls: unknown[] = []; let counter=0; let lastRunId='';
let failNextRunPost=false; let delayNextRunPost=false; let resolveDelayedPost: (()=>void)|null=null;let usageRequests=0;
class FakeEventSource {
  onopen: (()=>void)|null=null; onerror: (()=>void)|null=null;
  listeners:Record<string,(e:MessageEvent)=>void>={};
  constructor(){stream=this;setTimeout(()=>this.onopen?.(),10);}
  addEventListener(type:string,handler:(e:MessageEvent)=>void){this.listeners[type]=handler;}
  emitUsage(){this.listeners['usage.updated']?.({data:JSON.stringify({runId:'run-usage'})} as MessageEvent);}
  close(){}
  emit(type:string,runId:string){this.listeners[type]?.({data:JSON.stringify({runId,messages:[],error:"模拟失败"})} as MessageEvent);}
}
(globalThis as any).EventSource=FakeEventSource;
const realFetch=window.fetch.bind(window);
window.fetch=async(input, init)=>{
  const path=String(input);if(!path.startsWith('/api/'))return realFetch(input,init);
  let data: unknown = {};
  if(path.startsWith('/api/v1/presets?')) data={items:[],hasMore:false};
  else if(path==='/api/v1/api-model-configs') data={items:[]};
  else if(path==='/api/v1/sessions/test') data={tipEntryId:'tip',worldId:'world',title:'测试',presetId:null,apiModelConfigId:null};
  else if(path==='/api/v1/sessions/test/usage'){usageRequests++;data={cumulative:{inputTokens:250000,outputTokens:32000,totalTokens:282000,cacheReadTokens:80000,cacheWriteTokens:15000,cacheHitRate:.32,complete:true,unknownCount:0},latestContext:{inputTokens:9800,contextWindowTokens:128000,ratio:9800/128000,modelId:'fake',stale:false,contextComposition:{systemBytes:1000,summaryBytes:500,historyBytes:3000}}};}
  else if(path==='/api/v1/worlds/world') data={item:{data:{ui:{type:'react',source:"import React from 'react'; export default function Story(){return <div>Story</div>}"}}}};
  else if(path==='/api/v1/sessions/test/state') data={global:{},session:{},message:{}};
  else if(path.startsWith('/api/v1/sessions/test/runs?')) data={runs:[],nextCursor:null,hasMore:false};
  else if(path==='/api/v1/sessions/test/runs'&&init?.method==='POST') {
    calls.push(JSON.parse(String(init.body)));
    if(failNextRunPost){failNextRunPost=false;return new Response(JSON.stringify({code:'SIMULATED_FAILURE',message:'模拟请求失败'}),{status:500,headers:{'Content-Type':'application/json'}});}
    lastRunId=`run-${++counter}`;data={runId:lastRunId};
    const response=new Response(JSON.stringify({code:'OK',data}),{status:200,headers:{'Content-Type':'application/json'}});
    if(delayNextRunPost){delayNextRunPost=false;return new Promise<Response>(resolve=>{resolveDelayedPost=()=>resolve(response);});}
    return response;
  }
  return new Response(JSON.stringify({code:'OK',data}),{status:200,headers:{'Content-Type':'application/json'}});
};
const results:Array<{name:string;pass:boolean;error?:string}>=[];
const wait=(ms=100)=>new Promise(r=>setTimeout(r,ms));
function assert(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
async function test(name:string,fn:()=>Promise<void>){try{await fn();results.push({name,pass:true});}catch(e){results.push({name,pass:false,error:String(e)});}finally{document.getElementById('results')!.textContent=JSON.stringify(results);}}
function text(){return document.querySelector<HTMLElement>('[contenteditable]')?.innerText??'';}
async function typeBlock(value:string){const editor=document.querySelector<HTMLElement>('[contenteditable]')!;editor.focus();document.querySelector<HTMLButtonElement>('.sr-composer-tool-speech')!.click();await wait();editor.focus();document.execCommand('insertText',false,value);await wait();assert(text().includes(value),'typing did not insert content: '+text());}
async function send(){let b=document.querySelector<HTMLButtonElement>('.host-send-button')!;for(let i=0;i<100&&b.disabled;i++){await wait();b=document.querySelector<HTMLButtonElement>('.host-send-button')!;}assert(!b.disabled,'send is disabled');b.click();await wait();}
createRoot(document.getElementById('root')!).render(<div className="sr-shell"><SessionHost id="test"/></div>);
void (async()=>{
  for(let i=0;i<100;i++){await wait();if(document.querySelector<HTMLButtonElement>('.host-send-button')&&!document.querySelector('[contenteditable]')?.hasAttribute('aria-disabled')&&document.querySelector('iframe')){await wait(800);break;}}
  await test('renders token context composition in system, summary, history order and refreshes on usage.updated',async()=>{
    for(let i=0;i<100&&!document.querySelector('.host-usage-context .host-usage-segment');i++)await wait(20);
    const segments=Array.from(document.querySelectorAll('.host-usage-context .host-usage-segment')).map(node=>node.classList.contains('system')?'system':node.classList.contains('summary')?'summary':node.classList.contains('history')?'history':'unknown');
    assert(segments.join(',')==='system,summary,history','incorrect context segment order: '+segments.join(','));
    assert(document.querySelector('.host-usage-cumulative')?.textContent?.includes('282K'),'cumulative total is missing');
    const before=usageRequests;stream.emitUsage();for(let i=0;i<100&&usageRequests===before;i++)await wait(10);
    assert(usageRequests>before,'usage.updated did not refresh the usage endpoint');
  });
  await test('settings use a modal and font preview can be cancelled',async()=>{
    document.querySelector<HTMLButtonElement>('.host-settings-button')!.click();await wait(80);
    const dialog=document.querySelector<HTMLDialogElement>('.host-settings-dialog');
    assert(!!dialog?.open,'settings dialog did not open');
    const slider=dialog!.querySelector<HTMLInputElement>('.host-reading-slider')!;
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
    setter?.call(slider,'20');slider.dispatchEvent(new Event('input',{bubbles:true}));await wait();
    const previewed=dialog!.querySelector('output')?.textContent==='20px';
    dialog!.querySelector<HTMLButtonElement>('.host-settings-dialog-footer .secondary')!.click();await wait();
    assert(previewed,'font size preview did not update');
    assert(!document.querySelector<HTMLDialogElement>('.host-settings-dialog')?.open,'cancel did not close settings dialog');
  });
  await test('font-only preference can be saved without preset or model configuration',async()=>{
    document.querySelector<HTMLButtonElement>('.host-settings-button')!.click();await wait(80);
    const dialog=document.querySelector<HTMLDialogElement>('.host-settings-dialog')!;
    const slider=dialog.querySelector<HTMLInputElement>('.host-reading-slider')!;
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
    setter?.call(slider,'17');slider.dispatchEvent(new Event('input',{bubbles:true}));await wait(60);
    dialog.querySelector<HTMLButtonElement>('.host-settings-dialog-footer .primary')!.click();await wait(100);
    assert(localStorage.getItem('sr:session:test:reading-font-size')==='17','font-only save should not require a preset or model');
  });
  await test('POST serializes semantic text and clears immediately after acceptance',async()=>{
    await typeBlock('第一轮');await send();assert(calls.length===1,'not exactly one request');const payload=calls[0] as any;assert(typeof payload.text==='string'&&payload.text.includes('“第一轮”'),'incorrect serialized text');assert(!text().includes('第一轮'),'draft was not cleared after POST acceptance');stream.emit('run.stopped',lastRunId);await wait();assert(!text().includes('第一轮'),'stopped event restored submitted draft');
  });
  await test('send removes trailing blank rows but preserves blank rows in the middle',async()=>{
    const editor=document.querySelector<HTMLElement>('[contenteditable]')!;editor.focus();document.execCommand('insertText',false,'前文');
    editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await wait();
    editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await wait();
    document.execCommand('insertText',false,'后文');await wait();
    editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await wait();
    editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await wait();
    await send();
    const payload=calls[calls.length-1] as any;
    assert(payload.text.includes('前文\n\n\n\n后文'),'middle blank row was removed');
    assert(!payload.text.endsWith('\n'),'trailing blank rows were not removed');
    assert(!text().includes('前文'),'accepted message was not cleared');
    stream.emit('run.completed',lastRunId);await wait();
  });
  await test('failed POST preserves the current draft',async()=>{
    await typeBlock('请求失败');failNextRunPost=true;await send();assert(text().includes('请求失败'),'failed POST lost the draft');await send();assert(!text().includes('请求失败'),'successful retry did not clear the draft');stream.emit('run.completed',lastRunId);await wait();
  });
  await test('run.failed after accepted POST does not restore the submitted draft',async()=>{
    await typeBlock('运行失败');await send();assert(!text().includes('运行失败'),'accepted draft was not cleared');stream.emit('run.failed',lastRunId);await wait();assert(!text().includes('运行失败'),'failed event restored submitted draft');
  });
  await test('edits made while POST is pending survive the response and terminal event',async()=>{
    await typeBlock('本轮');delayNextRunPost=true;document.querySelector<HTMLButtonElement>('.host-send-button')!.click();
    for(let i=0;i<100&&!resolveDelayedPost;i++)await wait(10);
    assert(!!resolveDelayedPost,'POST did not enter delayed state');await typeBlock('新的草稿');resolveDelayedPost!();resolveDelayedPost=null;await wait();
    assert(text().includes('新的草稿'),'POST response cleared edits made while pending');stream.emit('run.completed',lastRunId);await wait();assert(text().includes('新的草稿'),'terminal event cleared the new draft');
  });
  document.getElementById('results')!.textContent=JSON.stringify(results);
})();
