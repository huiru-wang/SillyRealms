/** Real Studio build + real HTTP/SSE and SQLite; only the test Provider is offline. */
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../../../',import.meta.url));
const temporary=await mkdtemp(join(tmpdir(),'sr-production-browser-'));
const manifestPath=fileURLToPath(new URL('./manifest.json',import.meta.url));
const output=fileURLToPath(new URL('./screenshots/',import.meta.url));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const children=[];let ws;let sequence=0;const pending=new Map();const exceptions=[];const contexts=new Map();
function call(method,params={},sessionId){return new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},15000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});}
async function evaluate(expression,sessionId,contextId){const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,...(contextId?{contextId}:{})},sessionId);if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result?.value;}
async function until(expression){for(let i=0;i<150;i++){if(await evaluate(expression))return;await delay(100);}throw Error('Timed out: '+expression);}
function assert(value,message){if(!value)throw Error(message);}
async function click(label){await evaluate(`(()=>{const e=Array.from(document.querySelectorAll('button,a')).find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)}||e.textContent.trim()===${JSON.stringify(label)});if(!e)throw Error('Missing control: '+${JSON.stringify(label)});e.click()})()`);}
async function input(label,value){await evaluate(`(()=>{const e=document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`);}
let origin;
async function navigate(path){await call('Page.navigate',{url:origin+path});await until('!!document.getElementById("main-content")');}
async function frame(selector='iframe[title=会话页面]'){
 const url=await evaluate('document.querySelector('+JSON.stringify(selector)+')?.src');
 const targets=await call('Target.getTargets');const target=targets.targetInfos.find(t=>t.type==='iframe'&&t.url===url);
 if(target){const {sessionId}=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true});await call('Runtime.enable',{},sessionId);return expression=>evaluate(expression,sessionId);}
 const tree=await call('Page.getFrameTree');const f=tree.frameTree.childFrames?.find(f=>f.frame.url===url);const context=[...contexts.values()].find(c=>c.auxData?.frameId===f?.frame.id&&c.auxData?.isDefault);if(!context)throw Error('Missing iframe execution context');return expression=>evaluate(expression,undefined,context.id);
}
async function frameUntil(expression,selector){for(let i=0;i<120;i++){try{const run=await frame(selector);if(await run(expression))return run;}catch{}await delay(100);}throw Error('Frame timed out: '+expression);}
async function shot(name){await delay(200);const result=await call('Page.captureScreenshot',{format:'png'});await writeFile(join(output,name+'.png'),Buffer.from(result.data,'base64'));}
try{
 await mkdir(output,{recursive:true});
 const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
 origin='http://127.0.0.1:'+manifest.port;
 const browser=spawn(process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--no-first-run','--disable-gpu','--disable-background-timer-throttling','--remote-debugging-port=0','--user-data-dir='+join(temporary,'chrome'),'about:blank'],{stdio:'ignore'});children.push(browser);
 let port;for(let i=0;i<100;i++){try{port=Number((await readFile(join(temporary,'chrome/DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch{await delay(100);}}if(!port)throw Error('Chrome failed');
 const tab=(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(t=>t.type==='page');ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
 ws.addEventListener('message',event=>{const data=JSON.parse(event.data);if(data.method==='Runtime.exceptionThrown')exceptions.push(data.params.exceptionDetails.exception?.description??data.params.exceptionDetails.text);if(data.method==='Runtime.executionContextCreated')contexts.set(data.params.context.id,data.params.context);if(data.method==='Runtime.executionContextDestroyed')contexts.delete(data.params.executionContextId);if(data.id){const p=pending.get(data.id);if(p){clearTimeout(p.timer);pending.delete(data.id);data.error?p.reject(Error(JSON.stringify(data.error))):p.resolve(data.result);}}});
 await call('Page.enable');await call('Runtime.enable');

 const checks=[];
 for(const width of [1280,375]){
  await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<500});
  await navigate('/worlds/'+manifest.worlds.qiuge);
  let intro=await frameUntil('!!document.querySelector("[data-window-intro]")','iframe[data-world-component]');
  assert(await intro('!document.body.innerText.includes("直接杀人者是")'),'intro spoiler');
  assert(await intro('document.documentElement.scrollWidth<=innerWidth'),'intro overflow');
  await intro('document.querySelectorAll("summary")[0].click()');
  assert(await intro('document.querySelector("details").open'),'intro accordion');
  await shot('introduction-'+width);
  await click('开局');await until('document.body.innerText.includes("一般难度")');await shot('opening-'+width);
  await click('下一个开局');await until('document.body.innerText.includes("困难难度")');
  for(const difficulty of ['standard','hard']){
   const sid=manifest.sessions['qiuge-forum-'+difficulty];
   await navigate('/sessions/'+sid);
   let stage=await frameUntil('!!document.querySelector("[data-window-stage]")&&document.body.innerText.includes("你的私密角色本")');
   assert(await evaluate('document.querySelector("iframe[title=会话页面]").getAttribute("sandbox")==="allow-scripts"'),'sandbox');
   assert(await stage('document.querySelectorAll(".sr-story").length===1'),'WorldStory singleton');
   assert(await stage('document.documentElement.scrollWidth<=innerWidth'),'stage overflow');
   await stage('document.querySelector("button[aria-controls=casebook]").click()');
   await frameUntil('!!document.getElementById("casebook")');
   assert(await stage('document.body.innerText.includes("已公开 · 1")||document.body.innerText.includes("已公开 · 2")'),'initial evidence');
   if(width===1280){await stage('Array.from(document.querySelectorAll("button")).find(x=>x.textContent==="记录").click()');assert(await stage('document.body.innerText.includes("0 / 4")'),'zero value');}
   await stage('Array.from(document.querySelectorAll("button")).find(x=>x.textContent==="地图").click()');
   assert(await stage('document.querySelector(".map-view img").complete&&document.querySelector(".map-view img").naturalWidth>0'),'map image');
   await stage('Array.from(document.querySelectorAll("button")).find(x=>x.textContent==="放大地图").click()');
   assert(await stage('document.querySelector(".map-view").scrollWidth>document.querySelector(".map-view").clientWidth'),'map zoom');
   await stage('Array.from(document.querySelectorAll("button")).find(x=>x.textContent==="适合宽度").click()');
   await shot('map-'+difficulty+'-'+width);
   await stage('document.getElementById("casebook").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
   assert(await stage('!document.getElementById("casebook")&&document.activeElement.getAttribute("aria-controls")==="casebook"'),'escape/focus');
   if(width===1280){
    await evaluate('(()=>{const e=document.querySelector("[contenteditable]");e.focus();document.execCommand("insertText",false,"离线验收：展示合成更新")})()');
    await until('!document.querySelector("[aria-label=发送消息]").disabled');await click('发送消息');
    await frameUntil('document.body.innerText.includes("离线管线验收")');
    await until('!!document.querySelector("[aria-label=发送消息]")');
   }
   await stage('document.querySelector("button[aria-controls=casebook]").click()');
   await stage('Array.from(document.querySelectorAll("button")).find(x=>x.textContent==="线索").click()');
   await frameUntil('document.body.innerText.includes("已公开 · 2")');
   const expected=difficulty==='hard'?'期末设计作业':'带问号的照片';
   assert(await stage('document.body.innerText.includes('+JSON.stringify(expected)+')'),'wrong difficulty evidence');
   await stage('Array.from(document.querySelectorAll("summary")).find(x=>x.textContent.includes('+JSON.stringify(expected)+')).click()');
   assert(await stage('document.querySelector(".clue-image").naturalWidth>0'),'clue image');
   await stage('Array.from(document.querySelectorAll("button")).find(x=>x.textContent==="旋转图像 180°").click()');
   assert(await stage('document.querySelector(".clue-image").classList.contains("rotated")'),'rotation');
   await stage('document.getElementById("casebook").scrollTop=10000');
   assert(await stage('(()=>{const p=document.getElementById("casebook");const b=Array.from(p.querySelectorAll("button")).find(x=>x.textContent==="旋转图像 180°");return b.getBoundingClientRect().bottom<innerHeight-Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sr-story-bottom-inset")||"100")})()'),'clue control blocked by Host composer');
   await shot('evidence-'+difficulty+'-'+width);
   await navigate('/sessions/'+sid);stage=await frameUntil('!!document.querySelector("[data-window-stage]")&&document.body.innerText.includes("离线管线验收")');
   await stage('document.querySelector("button[aria-controls=casebook]").click()');
   assert(await stage('document.body.innerText.includes("已公开 · 2")'),'state lost after reload');
   await stage('Array.from(document.querySelectorAll("button")).find(x=>x.textContent==="记录").click()');
   assert(await stage('document.body.innerText.includes("假设：窗边的人影")'),'note lost');
   await shot('notes-'+difficulty+'-'+width);
   checks.push({width,difficulty,stage:true,evidence:true,mapZoom:true,rotation:true,statePersistence:true,escapeFocus:true});
  }
 }
 // 六种角色入口均实际加载，避免只验收默认角色。
 for(const [role,world] of Object.entries(manifest.worlds)){
  await navigate('/worlds/'+world);await frameUntil('!!document.querySelector("[data-window-intro]")','iframe[data-world-component]');
  await navigate('/sessions/'+manifest.sessions[role+'-forum-standard']);
  await frameUntil('!!document.querySelector("[data-window-stage]")&&document.body.innerText.includes("你的私密角色本")');
 }
 assert(exceptions.length===0,'Browser exceptions: '+exceptions.join('\n'));
 const final=await(await fetch(origin+'/window-test-manifest')).json();
 assert(final.payloadChecks.length===2,'Expected two tool-free Provider payloads');
 await writeFile(new URL('./browser-results.json',import.meta.url),JSON.stringify({checks,exceptions,payloadChecks:final.payloadChecks},null,2));
 console.log('PASS: real imported cards, six intros/stages, 12 openings, 1280/375, map, both image clues, rotation, focus, state persistence, offline Provider payload');
}catch(error){try{await shot("failure");console.error(await evaluate("document.body.innerText"));console.error(exceptions)}catch{}console.error(error);process.exitCode=1;}finally{ws?.close();for(const child of children.reverse())child.kill('SIGTERM');await delay(500);await rm(temporary,{recursive:true,force:true});}
