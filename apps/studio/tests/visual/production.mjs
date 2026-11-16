/** Real Studio build + real HTTP/SSE and SQLite; only the test Provider is offline. */
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cacheImageServer} from './cache-image-server.mjs';
import {checkModels} from './models.mjs';
import {checkSettings} from './settings.mjs';
import {checkMobile} from './mobile.mjs';
import {checkDensity} from './density.mjs';
const root=fileURLToPath(new URL('../../../..',import.meta.url));
const temporary=await mkdtemp(join(tmpdir(),'sr-production-browser-'));
const manifestPath=join(temporary,'manifest.json');
const output=fileURLToPath(new URL('./output/',import.meta.url));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const children=[];let ws,imageServer;let sequence=0;const pending=new Map();const exceptions=[];const contexts=new Map();
function call(method,params={},sessionId){return new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},15000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});}
async function evaluate(expression,sessionId,contextId){const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,...(contextId?{contextId}:{})},sessionId);if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result?.value;}
async function until(expression){for(let i=0;i<150;i++){if(await evaluate(expression))return;await delay(100);}throw Error('Timed out: '+expression);}
function assert(value,message){if(!value)throw Error(message);}
async function click(label){await evaluate(`(()=>{const e=Array.from(document.querySelectorAll('button,a')).find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)}||e.textContent.trim()===${JSON.stringify(label)});if(!e)throw Error('Missing control: '+${JSON.stringify(label)});e.focus({preventScroll:true});e.click()})()`);}
async function key(key,code=key){const windowsVirtualKeyCode=({Escape:27,Enter:13,Tab:9,ArrowDown:40,ArrowUp:38,Home:36,End:35})[key]??key.toUpperCase().charCodeAt(0);await call('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode,...(key==='Enter'?{text:'\r',unmodifiedText:'\r'}:{})});await call('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode});}
async function pointer(selector){const p=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);await call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});}
async function input(label,value){await evaluate(`(()=>{const e=document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`);}
let origin;
async function navigate(path){await call('Page.navigate',{url:origin+path});await until('!!document.getElementById("main-content")');}
async function setTheme(theme){
 const previous=await evaluate('location.pathname+location.search');
 await navigate('/settings');await until('!!document.querySelector("[role=combobox][aria-label=主题]")');
 await pointer('[role=combobox][aria-label=主题]');await until('!!document.querySelector("[role=listbox]")');
 await evaluate('[...document.querySelectorAll("[role=option]")].find(e=>e.textContent.trim()==='+JSON.stringify(theme==='light'?'浅色':'深色')+').click()');await until('document.documentElement.dataset.theme==='+JSON.stringify(theme));
 if(previous!=='/settings')await navigate(previous);
}
async function frame(selector='iframe[title=会话页面]'){
 const url=await evaluate('document.querySelector('+JSON.stringify(selector)+')?.src');
 const targets=await call('Target.getTargets');const target=targets.targetInfos.find(t=>t.type==='iframe'&&t.url===url);
 if(target){const {sessionId}=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true});await call('Runtime.enable',{},sessionId);return expression=>evaluate(expression,sessionId);}
 const tree=await call('Page.getFrameTree');const f=tree.frameTree.childFrames?.find(f=>f.frame.url===url||(f.frame.url+(f.frame.urlFragment??''))===url);const context=[...contexts.values()].find(c=>c.auxData?.frameId===f?.frame.id&&c.auxData?.isDefault);if(!context)throw Error('Missing iframe execution context');return expression=>evaluate(expression,undefined,context.id);
}
async function frameUntil(expression,selector){let lastError;for(let i=0;i<120;i++){try{const run=await frame(selector);if(await run(expression))return run;}catch(error){lastError=error;}await delay(100);}throw Error('Frame timed out: '+expression+'; '+String(lastError??'condition false')+'; Host: '+await evaluate('document.body.innerText'));}
async function checkSessionRows(width,name){
 await until('!!document.querySelector("[data-session-row]")');await delay(400);
 const metrics=await evaluate('(()=>{const row=document.querySelector("[data-session-row]"),r=row.getBoundingClientRect(),list=row.parentElement.getBoundingClientRect(),action=row.querySelector("[data-session-actions]").getBoundingClientRect(),time=row.querySelector("time").getBoundingClientRect();return {width:r.width,list:list.width,gap:r.right-action.right,timeGap:action.left-time.right,y:r.top+r.height/2,x:r.right-6}})()');
 assert(Math.abs(metrics.width-metrics.list)<2&&metrics.gap<=13&&metrics.timeGap>=7&&metrics.timeGap<=20,'Session row width/right alignment: '+JSON.stringify(metrics));
 assert(await evaluate('(()=>{const title=document.querySelector("[data-session-row] strong"),before=title.textContent;title.textContent="很长的会话标题".repeat(35);const row=title.closest("[data-session-row]"),ok=row.scrollWidth<=row.clientWidth+1&&document.documentElement.scrollWidth<=innerWidth;title.textContent=before;return ok})()'),'Long session title overflows');
 if(width>=1000){
  await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:metrics.x,y:metrics.y});await delay(180);
  assert(await evaluate('getComputedStyle(document.querySelector("[data-session-row]")).backgroundColor!=="rgba(0, 0, 0, 0)"'),'Hover does not cover action side of row: '+JSON.stringify(await evaluate('({hover:matchMedia("(hover:hover)").matches,rowHovered:document.querySelector("[data-session-row]").matches(":hover"),color:getComputedStyle(document.querySelector("[data-session-row]")).backgroundColor})')));
 }
 await shot(name+'-'+width);
}
async function shot(name){await delay(200);const result=await call('Page.captureScreenshot',{format:'png'});await writeFile(join(output,name+'.png'),Buffer.from(result.data,'base64'));}
try{
 await mkdir(output,{recursive:true});
 imageServer=await cacheImageServer(temporary);
 const server=spawn(join(root,'apps/server/node_modules/.bin/tsx'),['test/studio-browser-server.ts'],{cwd:join(root,'apps/server'),env:{...process.env,SR_TEST_MANIFEST:manifestPath,...(process.env.SR_BROWSER_ONLY==='mobile'?{SR_TEST_LAN_HOST:'sr-mobile.test'}:{}),SR_TEST_IMAGE_URL:imageServer.url},stdio:['ignore','pipe','pipe']});children.push(server);let logs='';server.stderr.on('data',chunk=>logs+=chunk);
 let manifest;for(let i=0;i<100;i++){try{manifest=JSON.parse(await readFile(manifestPath,'utf8'));break;}catch{await delay(100);}}if(!manifest)throw Error('Test API failed: '+logs);origin='http://'+(process.env.SR_BROWSER_ONLY==='mobile'?'sr-mobile.test':'127.0.0.1')+':'+manifest.port;
 const browser=spawn(process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--host-resolver-rules=MAP sr-mobile.test 127.0.0.1','--no-proxy-server','--no-first-run','--disable-gpu','--ignore-certificate-errors-spki-list='+imageServer.spki,'--disable-background-timer-throttling','--remote-debugging-port=0','--user-data-dir='+join(temporary,'chrome'),'about:blank'],{stdio:'ignore'});children.push(browser);
 let port;for(let i=0;i<100;i++){try{port=Number((await readFile(join(temporary,'chrome/DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch{await delay(100);}}if(!port)throw Error('Chrome failed');
 const tab=(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(t=>t.type==='page');ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
 ws.addEventListener('message',event=>{const data=JSON.parse(event.data);if(data.method==='Runtime.exceptionThrown')exceptions.push(data.params.exceptionDetails.exception?.description??data.params.exceptionDetails.text);if(data.method==='Runtime.executionContextCreated')contexts.set(data.params.context.id,data.params.context);if(data.method==='Runtime.executionContextDestroyed')contexts.delete(data.params.executionContextId);if(data.id){const p=pending.get(data.id);if(p){clearTimeout(p.timer);pending.delete(data.id);data.error?p.reject(Error(JSON.stringify(data.error))):p.resolve(data.result);}}});
 await call('Page.enable');await call('Runtime.enable');
 await call('Network.enable');await call('Network.setCacheDisabled',{cacheDisabled:false});
 if(process.env.SR_BROWSER_ONLY==='density'){
  await checkDensity({call,evaluate,until,navigate,click,shot,assert,pointer,key,frameUntil});
  assert(exceptions.length===0,'Browser exceptions: '+exceptions.join('\n'));
 }else if(process.env.SR_BROWSER_ONLY==='mobile'){
  await checkMobile({call,evaluate,until,navigate,click,shot,assert,frameUntil,manifest,exceptions});
  assert(exceptions.length===0,'Browser exceptions: '+exceptions.join('\n'));
 }else if(process.env.SR_BROWSER_ONLY==='settings'){
  await checkSettings({call,evaluate,until,navigate,click,shot,assert,setTheme});
  assert(exceptions.length===0,'Browser exceptions: '+exceptions.join('\n'));
 }else if(process.env.SR_BROWSER_ONLY==='models'){
  await checkModels({origin,call,evaluate,until,navigate,click,shot,assert,setTheme});
  assert(exceptions.length===0,'Browser exceptions: '+exceptions.join('\n'));
 }else{
 await call('Emulation.setDeviceMetricsOverride',{width:1280,height:850,deviceScaleFactor:1,mobile:false});
 await navigate('/sessions/'+manifest['cache-world']);
 const cacheMetrics=async()=>{
  const run=await frameUntil('document.querySelector("[data-cache-image]")?.complete&&document.querySelector("[data-cache-image]").naturalWidth===64');
  return run('(async()=>{const img=document.querySelector("[data-cache-image]");await img.decode();let isolated=false;try{void parent.document.body}catch{isolated=true}return {isolated,src:img.src,transfer:performance.getEntriesByName(img.src).at(-1)?.transferSize}})()');
 };
 const first=await cacheMetrics();assert(first.isolated&&imageServer.requests.length===1&&first.transfer>0,'Initial cache image or DOM isolation failed');
 const oldFrame=await evaluate('document.querySelector("iframe[title=会话页面]").src');
 await evaluate('document.querySelector(\'a[href="/sessions"]\').click()');await until('location.pathname==="/sessions"&&!document.querySelector("iframe[title=会话页面]")');
 await until('!!document.querySelector('+JSON.stringify('[data-session-row] a[href="/sessions/'+manifest['cache-world']+'"]')+')');
 await evaluate('document.querySelector('+JSON.stringify('a[href="/sessions/'+manifest['cache-world']+'"]')+').click()');
 await until('location.pathname==='+JSON.stringify('/sessions/'+manifest['cache-world']));
 const reenter=await cacheMetrics();assert(reenter.src===first.src&&reenter.transfer===0&&imageServer.requests.length===1,'Reenter downloaded the cached image');
 assert(await evaluate('document.querySelector("iframe[title=会话页面]").src!=='+JSON.stringify(oldFrame)),'Reenter did not rebuild the real Stage');
 const beforeStageReload=await evaluate('document.querySelector("iframe[title=会话页面]").src');
 await call('Page.reload',{ignoreCache:false});await until('!!document.querySelector("iframe[title=会话页面]")&&document.querySelector("iframe[title=会话页面]").src!=='+JSON.stringify(beforeStageReload));
 const refresh=await cacheMetrics();assert(refresh.transfer===0&&imageServer.requests.length===1,'Normal reload downloaded the cached image');
 await writeFile(join(output,'stage-cache.json'),JSON.stringify({first,reenter,refresh,requests:imageServer.requests},null,2));
 const stageOrigin=await evaluate('new URL(document.querySelector("iframe[title=会话页面]").src).origin');
 assert(stageOrigin!==origin,'Stage is not cross-origin');
 assert((await fetch(origin+'/frame.html')).status===404,'Platform still serves the session code execution entry');
 assert((await fetch(stageOrigin+'/api/v1/worlds')).status===404,'Stage serves business API');
 assert((await fetch(origin+'/api/v1/tags',{method:'POST',headers:{Origin:stageOrigin,'Content-Type':'text/plain'},body:JSON.stringify({type:'world',name:'must-not-write'})})).status===403,'Stage origin can directly mutate platform data');
 const stageRun=await frame();assert(await stageRun('(async()=>{try{await fetch('+JSON.stringify(origin+'/api/v1/worlds')+');return false}catch{return true}})()'),'Stage CSP no longer blocks direct HTTP');
 // Navigation revokes the old port. Retrying restores the Stage without resetting the Host draft or sending a Run.
 await evaluate('(()=>{const e=document.querySelector("[contenteditable]");e.focus();})()');await call('Input.insertText',{text:'重试后应保留的草稿'});
 await evaluate('document.querySelector("iframe[title=会话页面]").src="about:blank"');
 await until('document.body.innerText.includes("故事舞台暂时无法连接")');
 await shot('production-stage-retry-1280');
 await call('Emulation.setDeviceMetricsOverride',{width:375,height:850,deviceScaleFactor:1,mobile:true});await shot('production-stage-retry-375');
 assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'Stage error overflows at 375px');
 await call('Emulation.setDeviceMetricsOverride',{width:1280,height:850,deviceScaleFactor:1,mobile:false});
 await click('重试舞台');await cacheMetrics();
 assert(await evaluate('document.querySelector("[contenteditable]").innerText.includes("重试后应保留的草稿")'),'Stage retry cleared the Host draft');
 const recovered=(await(await fetch(origin+'/api/v1/sessions/'+manifest['cache-world'])).json()).data;
 assert(!recovered.activeRun,'Stage retry submitted a Run');
 assert(imageServer.requests.length===1,'Stage retry bypassed browser cache');
 console.log('PASS: Stage image cache survives session reentry/reload/retry, DOM/API isolation and draft preservation');
 // Details keep readonly capabilities and fresh component state while reusing image bytes.
 const previewSamples=[];
 const previewMetrics=async(label,entry)=>{
  const run=await frameUntil('document.querySelector("[data-cache-entry]")?.dataset.cacheEntry==='+JSON.stringify(entry)+'&&document.querySelector("[data-preview-cache]")?.complete&&document.querySelector("[data-preview-cache]").naturalWidth===64&&document.querySelector("[data-state-check]")?.dataset.stateCheck==="state-safe"','iframe[data-world-component]');
  const metrics=await run('(async()=>{const img=document.querySelector("[data-preview-cache]");await img.decode();let isolated=false;try{void parent.document.body}catch{isolated=true}return {src:img.src,transfer:performance.getEntriesByName(img.src).at(-1)?.transferSize,isolated,count:document.querySelector("[data-preview-count]").textContent}})()');
  assert(metrics.isolated&&metrics.count==='0','Preview lost DOM isolation or retained old component state');
  const requests=imageServer.requests.filter(request=>request.url==='/image.svg?detail');
  assert(requests.length===1,'Details downloaded the same cached image again: '+JSON.stringify({label,metrics,requests}));
  assert(previewSamples.length?metrics.transfer===0:metrics.transfer>0,'Unexpected preview transfer: '+label);
  previewSamples.push({label,...metrics,requests:requests.length});return run;
 };
 await navigate('/worlds/preview-cache-world');
 let previewRun=await previewMetrics('introduction','CacheIntro');
 const previewURL=await evaluate('document.querySelector("iframe[data-world-component]").src');
 assert(new URL(previewURL).origin===stageOrigin,'Detail does not use the isolated asset origin');
 assert((await fetch(origin+'/world-component.html')).status===404,'Host still serves the readonly code execution entry');
 assert((await fetch(previewURL)).headers.get('Content-Security-Policy')==='sandbox allow-scripts allow-same-origin','Preview response lost sandbox');
 await previewRun('document.querySelector("[data-preview-count]").click()');
 await evaluate('void(window.__oldPreview=document.querySelector("iframe[data-world-component]"))');
 await click('开局');await previewMetrics('first opening','CacheOpening1');
 assert(await evaluate('!window.__oldPreview.isConnected'),'Introduction/media remain mounted after switching');
 await click('下一个开局');await previewMetrics('second opening','CacheOpening2');
 await click('上一个开局');await previewMetrics('first opening again','CacheOpening1');
 await click('介绍');await previewMetrics('introduction again','CacheIntro');
 await evaluate(`document.querySelector('a[href="/worlds"]').click()`);await until('location.pathname==="/worlds"');
 await until(`!!document.querySelector('button[aria-label="查看世界卡：详情缓存回归"]')`);
 await click('查看世界卡：详情缓存回归');
 await previewMetrics('reenter details','CacheIntro');
 const beforePreviewReload=await evaluate('document.querySelector("iframe[data-world-component]").src');
 await call('Page.reload',{ignoreCache:false});await until('!!document.querySelector("iframe[data-world-component]")&&document.querySelector("iframe[data-world-component]").src!=='+JSON.stringify(beforePreviewReload));
 await previewMetrics('reload details','CacheIntro');
 // A navigated document must lose its bridge and recover only through a fresh retry.
 await evaluate('document.querySelector("iframe[data-world-component]").src="about:blank"');
 await until('document.body.innerText.includes("组件加载失败")');await click('重试');
 await previewMetrics('retry details','CacheIntro');
 await writeFile(join(output,'preview-cache.json'),JSON.stringify({samples:previewSamples,requests:imageServer.requests.filter(request=>request.url==='/image.svg?detail')},null,2));
 console.log('PASS: detail image cache across introduction/opening switches, reentry/reload/retry; readonly scope, DOM isolation and fresh component state');
 for(const width of [1280,375]){
  await call('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:width<500});
  await navigate('/worlds');await until('document.body.innerText.includes("灯火长街")');assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'World list horizontal overflow');if(width===1280){const alignment=await evaluate('(()=>{const b=document.querySelector("button[aria-label=返回世界卡]").getBoundingClientRect(),h=document.querySelector("#main-content h1").getBoundingClientRect();return Math.abs(b.top+b.height/2-h.top-h.height/2)})()');assert(alignment<=3,'Title/brand alignment: '+alignment);}await shot('production-worlds-'+width);
  await navigate('/worlds/browser-world');await until('!!document.querySelector("[data-world-content] iframe")');await frameUntil('document.querySelector("[data-state-check]")?.dataset.stateCheck==="state-safe"','iframe[data-world-component]');assert(await evaluate('document.querySelector("iframe[data-world-component]").getAttribute("sandbox")=="allow-scripts allow-same-origin"'),'Detail sandbox changed');
  assert(await evaluate('(()=>{const strips=[...document.querySelectorAll("[data-role-strip]")];return strips.every(strip=>strip.querySelectorAll("[data-role-action=select]").length===2&&strip.querySelector("[data-role-card=player] [data-role-action=select]").getAttribute("aria-pressed")==="true"&&!strip.querySelector("[data-role-card=resident-0] [data-role-action=select]"))})()'),'Default playable selection/eligibility incorrect: '+JSON.stringify(await evaluate('[...document.querySelectorAll("[data-role-strip]")].map(strip=>({strip:strip.dataset.roleStrip,buttons:[...strip.querySelectorAll("[data-role-action=select]")].map(button=>({text:button.textContent,pressed:button.getAttribute("aria-pressed"),role:button.closest("[data-role-card]").dataset.roleCard}))}))')));
  await pointer('[data-role-strip=expanded] [data-role-card=resident-1] [data-role-action=select]');
  assert(await evaluate('!document.querySelector("[role=dialog]")&&[...document.querySelectorAll("[data-role-card=resident-1] [data-role-action=select]")].every(button=>button.textContent==="已选中"&&button.getAttribute("aria-pressed")==="true")'),'Selecting a role opened details or failed to synchronize selection');
  await pointer('[data-role-strip=expanded] [data-role-card=resident-0] [data-role-action=details]');await until('!!document.querySelector("[role=dialog]")');await key('Escape');await until('!document.querySelector("[role=dialog]")');
  assert(await evaluate('document.querySelector("[data-role-strip=expanded] [data-role-card=resident-1] [data-role-action=select]").getAttribute("aria-pressed")==="true"'),'Inspecting an NPC changed the playable selection');
  await shot('production-role-selection-expanded-'+width);
  await click('收起世界概览');await until('Number(document.querySelector("[data-collapse-progress]").dataset.collapseProgress)>.99');
  assert(await evaluate('(()=>{const roles=document.querySelector("[aria-label=世界内容导航]").getBoundingClientRect(),more=document.querySelector("[aria-label=世界卡更多操作]").getBoundingClientRect();return roles.right<=more.left-8||roles.top>=more.bottom+8})()'),'Collapsed role strip overlaps actions');
  assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'Detail horizontal overflow');await shot('production-collapsed-'+width);
  await click('展开世界概览');await until('Number(document.querySelector("[data-collapse-progress]").dataset.collapseProgress)<.01');
  await click('世界卡更多操作');await until('!!document.querySelector("[role=menu]")');assert(await evaluate('document.querySelector("[role=menu]").innerText.includes("导出世界卡")&&document.querySelector("[role=menu]").innerText.includes("删除世界卡")'),'World actions missing');await shot('production-world-menu-'+width);await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await until('!document.querySelector("[role=menu]")');
  await click('世界卡更多操作');await click('删除世界卡');await until('!!document.querySelector("[role=dialog]")');await click('取消');await until('!document.querySelector("[role=dialog]")');assert(await evaluate('document.activeElement?.getAttribute("aria-label")==="世界卡更多操作"'),'World delete cancel loses focus');
  const exported=await(await fetch(origin+'/api/v1/worlds/browser-world/export')).json();assert(!('summary' in exported.data),'World export still contains summary');
  await click('会话');await checkSessionRows(width,'production-world-sessions');await pointer('[data-session-actions] button');assert(await evaluate('location.pathname.includes("/worlds/")&&document.querySelector("[data-session-actions] button").getAttribute("aria-expanded")==="true"'),'More action navigates instead of opening');await key('Escape');
  if(await evaluate('Number(document.querySelector("[data-collapse-progress]").dataset.collapseProgress)<.99')){await click('收起世界概览');await until('Number(document.querySelector("[data-collapse-progress]").dataset.collapseProgress)>.99');}
  await pointer('[data-role-strip=compact] [data-role-card=resident-1] [data-role-action=select]');await key('Home');await key('Enter');
  assert(await evaluate('document.querySelector("[data-role-strip=compact] [data-role-card=player] [data-role-action=select]").getAttribute("aria-pressed")==="true"'),'Keyboard selection did not choose first playable role');
  await key('End');await key('Enter');
  assert(await evaluate('(()=>{const strip=document.querySelector("[data-role-strip=compact]"),overview=document.querySelector("[data-world-overview]").getBoundingClientRect(),button=strip.querySelector("[data-role-card=resident-1] [data-role-action=select]"),r=button.getBoundingClientRect();return button.getAttribute("aria-pressed")==="true"&&r.height>=24&&r.height<=28&&r.bottom<=overview.bottom&&document.documentElement.scrollWidth<=innerWidth})()'),'Compact role selection is clipped or overflows');
  await shot('production-role-selection-compact-'+width);
  await click('世界书');await until('document.querySelectorAll("[data-lore-entry]").length===3');
  assert(await evaluate('document.querySelector("[data-lore-entry=lore-keyword]").innerText.includes("关键字")&&document.querySelector("[data-lore-entry=lore-keyword]").innerText.includes("世界书")&&document.querySelector("[data-lore-entry=lore-disabled]").innerText.includes("已关闭")'),'Lore metadata missing');
  await evaluate('document.querySelector("[data-lore-entry=lore-always] button").click()');await until('!!document.querySelector("[data-lore-entry] [role=region] iframe")');await delay(300);
  assert(await evaluate('(()=>{const r=document.querySelector("[data-lore-entry] [role=region]");return r.clientHeight<=320&&r.scrollHeight>r.clientHeight&&getComputedStyle(r).overflowY==="auto"})()'),'Lore reading pane not bounded');await shot('production-lore-'+width);
  await evaluate('document.querySelector("[data-lore-entry=lore-keyword] button").click()');assert(await evaluate('document.querySelectorAll("[data-lore-entry] [role=region]").length===1&&!document.querySelector("[data-lore-entry=lore-always] [role=region]")'),'Lore accordion opens more than one item');
  await click('开局');await until('Array.from(document.querySelectorAll("button")).some(e=>e.textContent==="开始会话")');assert(await evaluate('!document.querySelector("[data-world-content] select")&&!document.querySelector("[data-world-content]").innerText.includes("使用此世界的运行配置")'),'Opening retains role selection/obsolete copy');
  assert(await evaluate('(()=>{const buttons=Array.from(document.querySelectorAll("button")),state=buttons.find(e=>e.textContent==="查看初始状态").getBoundingClientRect(),start=buttons.find(e=>e.textContent==="开始会话").getBoundingClientRect();return start.left>=state.right+5&&Math.abs(start.top+start.height/2-state.top-state.height/2)<2&&start.right<=innerWidth})()'),'Opening actions not aligned');await frameUntil('!!document.querySelector("[data-opening-preview]")&&document.querySelector("[data-state-check]")?.dataset.stateCheck==="state-safe"','iframe[data-world-component]');await shot('production-world-'+width);await evaluate('void(window.__previousOpening=document.querySelector("iframe[data-world-component]"))');await click('下一个开局');await frameUntil('!!document.querySelector("[data-second-preview]")','iframe[data-world-component]');assert(await evaluate('!window.__previousOpening.isConnected'),'Previous preview/media document remains mounted');await click('上一个开局');await frameUntil('!!document.querySelector("[data-opening-preview]")','iframe[data-world-component]');
  await click('运行配置');await until('document.querySelectorAll("[role=combobox]").length===2');
  await pointer('[role=combobox][aria-label=预设]');await until('!!document.querySelector("[role=listbox]:popover-open")');
  assert(await evaluate('(()=>{const b=document.querySelector("[role=combobox]"),r=b.getBoundingClientRect(),arrow=b.querySelector("svg").getBoundingClientRect(),menu=document.querySelector("[role=listbox]").getBoundingClientRect();return arrow.right<=r.right-8&&menu.left>=0&&menu.right<=innerWidth&&menu.bottom<=innerHeight&&document.activeElement===b})()'),'Select arrow/menu overflow or lost focus');
  await shot('production-select-'+width);await key('End');await key('Enter');await until('document.querySelector("[role=combobox][aria-label=预设]").innerText.includes("标准叙事")&&!document.querySelector("[role=listbox]")');
  await pointer('[role=combobox][aria-label=预设]');await key('Home');await key('Escape');assert(await evaluate('document.querySelector("[role=combobox][aria-label=预设]").innerText.includes("标准叙事")'),'Escape changed selection');
  await pointer('[role=combobox][aria-label=模型]');await pointer('[role=listbox] [role=option]:last-child');await until('!document.querySelector("[role=listbox]")');
  await click('保存配置');await until('document.body.innerText.includes("运行配置已保存")');
  const configured=await(await fetch(origin+'/api/v1/worlds/browser-world')).json();assert(configured.data.item.defaultPresetId==='sr-default-preset'&&configured.data.item.defaultApiModelConfigId==='test-model','Select values did not reach Server');
  await pointer('[role=combobox][aria-label=预设]');await key('Tab');assert(await evaluate('!document.querySelector("[role=listbox]")&&document.activeElement?.getAttribute("aria-label")==="模型"'),'Tab did not move to next select');
  await pointer('[role=combobox][aria-label=模型]');await pointer('[data-world-section=开局]');await until('!document.querySelector("[role=listbox]")');
  const countSessions=async()=>((await(await fetch(origin+'/api/v1/sessions?worldId=browser-world')).json()).data.items.length);
  const beforeCreate=await countSessions();
  await click('开始会话');await until('!!document.querySelector("[role=dialog]")');
  assert(await evaluate('(()=>{const dialog=document.querySelector("[role=dialog]");return dialog.innerText.includes("灯火初上")&&dialog.innerText.includes("长街居民 2")&&!dialog.querySelector("input,select,[role=combobox]")&&[...dialog.querySelectorAll("dd")].length===2})()'),'Confirmation does not show readonly opening and selected role');
  assert(await countSessions()===beforeCreate,'Opening confirmation already created a session');
  await shot('production-start-confirmation-'+width);
  await click('取消');await until('!document.querySelector("[role=dialog]")');
  assert(await countSessions()===beforeCreate&&await evaluate('document.activeElement?.textContent==="开始会话"'),'Cancel created a session or lost trigger focus');
  await click('开始会话');await until('!!document.querySelector("[role=dialog]")');await key('Escape');await until('!document.querySelector("[role=dialog]")');
  await click('开始会话');await until('!!document.querySelector("[role=dialog]")');
  if(width===1280){
   await fetch(origin+'/api/v1/worlds/browser-world',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({defaultApiModelConfigId:null})});
   await click('确认开始');await until('!!document.querySelector("[role=dialog] [role=alert]")');
   assert(await countSessions()===beforeCreate&&await evaluate('document.querySelector("[role=dialog]").innerText.includes("长街居民 2")'),'Failed creation lost confirmation or created a session');
   await shot('production-start-confirmation-error');
   await fetch(origin+'/api/v1/worlds/browser-world',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({defaultApiModelConfigId:'test-model'})});
  }
  await evaluate('(()=>{const button=[...document.querySelectorAll("[role=dialog] button")].find(button=>button.textContent==="确认开始");button.click();button.click()})()');
  await until('location.pathname.startsWith("/sessions/")&&!!document.querySelector("[contenteditable]")');
  assert(await countSessions()===beforeCreate+1,'Confirmation submitted more than one session');await frameUntil('document.body.innerText.includes("暮色落下")&&!document.querySelector("[data-component-badge]")');
  assert(await evaluate('document.querySelector("header h1")?.textContent==="灯火初上"'),'Session title does not use the selected opening name');
  const createdSession=await evaluate('(async()=>{const result=await (await fetch("/api/v1"+location.pathname)).json();return result.data})()');assert(createdSession.title==='灯火初上'&&createdSession.userCharacterId==='resident-1','Opening title or chosen role was not persisted by session creation');
  assert(await evaluate('document.querySelector("iframe[title=会话页面]").getAttribute("sandbox")==="allow-scripts allow-same-origin"'),'Stage sandbox changed');
  await evaluate('document.querySelector(".sr-composer-editor").focus()');assert(await evaluate('(()=>{const e=document.querySelector(".sr-composer-editor"),s=getComputedStyle(e);return s.outlineStyle==="none"&&s.borderTopWidth==="0px"&&s.boxShadow==="none"})()'),'Inner composer still has focus border');await shot('production-composer-focus-'+width);
  const story=await frameUntil('document.querySelectorAll(".sr-rp-speech").length===2');assert(await story('!!document.querySelector(".sr-rich h2")&&!!document.querySelector(".sr-rich blockquote")&&!!document.querySelector(".sr-rp-speech strong")&&document.querySelectorAll(".sr-task-marker").length===2&&getComputedStyle(document.querySelector(".sr-rp-speech")).color==="rgb(239, 176, 93)"'),'WorldStory Markdown/speech styling missing');assert(await story('getComputedStyle(document.querySelector(".sr-rich ol")).listStyleType==="decimal"&&getComputedStyle(document.querySelector(".sr-rich ul li:not(:has(.sr-task-marker))")).listStyleType==="disc"'),'Markdown list markers hidden by iframe reset');
  if(width===1280){await setTheme('light');await frameUntil('document.documentElement.dataset.theme==="light"');await evaluate('document.querySelector(".sr-composer-editor").focus()');assert(await (await frameUntil('!!document.querySelector(".sr-rp-speech")'))('getComputedStyle(document.querySelector(".sr-rp-speech")).color==="rgb(166, 91, 0)"'),'Light speech color missing');await shot('production-story-light');await setTheme('dark');await frameUntil('document.documentElement.dataset.theme==="dark"');}


  await until('!document.querySelector("[aria-label=发送消息]").disabled || !!document.querySelector("[contenteditable]")');
  await evaluate('(()=>{const e=document.querySelector("[contenteditable]");e.focus();document.execCommand("insertText",false,"继续故事")})()');await until('!document.querySelector("[aria-label=发送消息]").disabled');await click('发送消息');
  await frameUntil('document.body.innerText.includes("故事继续")');await until('!!document.querySelector("[aria-label=发送消息]")');await frameUntil('document.body.innerText.includes("远处的灯火")');
  const runStatus=await evaluate('(async()=>{const result=await(await fetch("/api/v1"+location.pathname+"/runs")).json();return result.data.runs.at(-1)?.status})()');
  assert(runStatus==='completed','Send did not complete successfully: '+runStatus);
  await frameUntil('!!document.querySelector("[data-component-badge]")');await shot('production-session-'+width);
  await frameUntil('document.querySelectorAll(".sr-suggestions button:not(:disabled)").length===3');
  assert(await (await frame())('!!document.querySelector("article.assistant .sr-suggestions")'),'Suggestions are not bound to a message');
  await (await frame())('document.querySelector(".sr-suggestions button").click()');await until('document.querySelector("[contenteditable]").innerText.includes("观察四周")');
  const sessionPath=await evaluate('location.pathname');await navigate(sessionPath);await frameUntil('document.body.innerText.includes("继续故事")&&document.body.innerText.includes("远处的灯火")');assert(await (await frame())('!document.querySelector(".sr-suggestions")'),'Refresh reconstructed suggestions');
  await evaluate('(()=>{const e=document.querySelector("[contenteditable]");e.focus();document.execCommand("insertText",false,"停止这一轮")})()');await until('!document.querySelector("[aria-label=发送消息]").disabled');await click('发送消息');await until('!!document.querySelector("[aria-label=停止生成]")');await click('停止生成');await until('!!document.querySelector("[aria-label=发送消息]")');
  await click('会话设置');await until('!!document.querySelector("dialog[open]")');await shot('production-session-settings-'+width);await pointer('dialog [role=combobox][aria-label="预设"]');await until('!!document.querySelector("dialog [role=listbox]:popover-open")');await shot('production-dialog-select-'+width);await key('Escape');assert(await evaluate('!!document.querySelector("dialog[open]")&&!document.querySelector("[role=listbox]")'),'Escape closed dialog along with select');await key('Escape');await until('!document.querySelector("dialog[open]")');
  await navigate('/presets/sr-default-preset');await until('!!document.querySelector("[aria-label=最大上下文输入]")');await input('最大上下文输入',String(width===1280?24576:24577));await click('保存预设');await until('document.body.innerText.includes("预设已保存")');await shot('production-presets-'+width);await navigate('/presets/sr-default-preset');await until('document.querySelector("[aria-label=最大上下文输入]")?.value==='+JSON.stringify(String(width===1280?24576:24577)));
  await evaluate('Array.from(document.querySelectorAll("button")).find(e=>e.textContent.replace(/\s/g,"").startsWith("世界状态查看提示词")).click()');await until('!!document.querySelector("[role=dialog] pre")');
  assert(await evaluate('document.querySelector("[role=dialog] pre").textContent.includes("state.currentValues")'),'Node template is not visible');await shot('production-node-prompt-'+width);
  await evaluate('document.querySelector("[role=dialog] summary").click()');await until('document.querySelectorAll("[aria-label=预览会话] option").length>1||document.querySelector("[aria-label=预览会话]")?.parentElement.querySelectorAll("option").length>1');
  await pointer('[role=dialog] [role=combobox][aria-label=预览会话]');await until('!!document.querySelector("[role=listbox]")');await evaluate('document.querySelectorAll("[role=listbox] [role=option]")[1].click()');await click('展开节点');await until('document.querySelector("[role=dialog]").innerText.includes("完整候选输入估算")');
  assert(await evaluate('document.querySelectorAll("[role=dialog] pre").length===2'),'Expanded node preview missing');
  await click('关闭弹窗');await until('!document.querySelector("[role=dialog]")');
  await click('启用行动建议');await click('保存预设');await until('document.body.innerText.includes("预设已保存")');
  await navigate('/presets/sr-default-preset');await until('document.querySelector("[aria-label=启用行动建议]")?.getAttribute("aria-checked")==="false"');await click('启用行动建议');await click('保存预设');await until('document.body.innerText.includes("预设已保存")');
  await navigate('/sessions');await until('!!document.querySelector("#main-content h1")');assert(await evaluate('!document.querySelector("#main-content").innerText.includes("开始新的故事")'),'Session list retains new-story CTA');await checkSessionRows(width,'production-session-list');
  await navigate('/models');await until('document.body.innerText.includes("test-model")');if(width<500)assert(await evaluate('!!document.querySelector("nav[aria-label=手机主导航]")'),'Mobile models has no navigation');await shot('production-models-'+width);
  await click('添加模型');await until('!!document.querySelector("[role=dialog]")');await pointer('[role=combobox][aria-label=服务商]');await until('document.querySelectorAll("[role=listbox] [role=option]").length>5');await key('End');
  assert(await evaluate('(()=>{const menu=document.querySelector("[role=listbox]"),r=menu.getBoundingClientRect(),active=menu.querySelector("[data-active=true]").getBoundingClientRect();return r.height<=288&&r.bottom<=innerHeight&&active.bottom<=r.bottom&&active.top>=r.top})()'),'Long select menu not bounded/active option not visible');
  await key('o','KeyO');assert(await evaluate('document.querySelector("[role=listbox] [data-active=true]").innerText.toLowerCase().startsWith("o")'),'Select typeahead failed');await key('Enter');await until('!document.querySelector("[role=listbox]")');
  assert(await evaluate('document.querySelector("[role=combobox][aria-label=服务商]").innerText.toLowerCase().startsWith("o")'),'Provider selection failed');
  await pointer('[role=combobox][aria-label=模型]');await shot('production-model-select-'+width);await key('Escape');assert(await evaluate('!!document.querySelector("[role=dialog]")&&!document.querySelector("[role=listbox]")'),'Select Escape dismissed custom modal');await click('取消');await until('!document.querySelector("[role=dialog]")');
  await navigate('/settings');await until('!!document.querySelector(".settings-row select")');if(width<500){const metrics=await evaluate('(()=>{const n=document.querySelector("nav[aria-label=手机主导航]");const r=n?.getBoundingClientRect();return {present:!!n,bottom:r?.bottom,top:r?.top,height:innerHeight,display:n&&getComputedStyle(n).display}})()');assert(metrics.present&&metrics.display!=="none"&&metrics.bottom<=metrics.height,'Settings navigation off screen: '+JSON.stringify(metrics));}await shot('production-settings-'+width);
 }
 // Check the same controls across responsive breakpoints in the light theme.
 await call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});await navigate('/worlds/browser-world');await until('!!document.querySelector("[data-world-overview]")');await setTheme('light');
 for(const width of [1440,1024,768,390,320]){
  await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<500});
  if(await evaluate('!!document.querySelector("[aria-label=收起世界概览]")'))await click('收起世界概览');await until('Number(document.querySelector("[data-collapse-progress]").dataset.collapseProgress)>.99');
  assert(await evaluate('(()=>{const r=document.querySelector("[aria-label=世界内容导航]").getBoundingClientRect(),b=document.querySelector("[aria-label=世界卡更多操作]").getBoundingClientRect();return r.right<=b.left-8||r.top>=b.bottom+8})()'),'Header overlap at '+width);
  await click('开局');await until('Array.from(document.querySelectorAll("button")).some(e=>e.textContent==="开始会话")');await shot('production-opening-light-'+width);
  assert(await evaluate('(()=>{const buttons=Array.from(document.querySelectorAll("button")),state=buttons.find(e=>e.textContent==="查看初始状态").getBoundingClientRect(),start=buttons.find(e=>e.textContent==="开始会话").getBoundingClientRect();return start.left>=state.right+5&&Math.abs(start.top+start.height/2-state.top-state.height/2)<2&&start.right<=innerWidth})()'),'Opening alignment at '+width);
  await click('运行配置');await until('document.querySelectorAll("[role=combobox]").length===2&&!document.querySelector("[role=combobox][aria-label=模型]").disabled');await pointer('[role=combobox][aria-label=模型]');await until('!!document.querySelector("[role=listbox]:popover-open")');
  assert(await evaluate('(()=>{const menu=document.querySelector("[role=listbox]"),r=menu.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&document.documentElement.scrollWidth<=innerWidth&&getComputedStyle(menu).backgroundColor==="rgb(255, 255, 255)"})()'),'Light select viewport/theme at '+width);await shot('production-select-light-'+width);await key('Escape');
 }
 await call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});await navigate('/sessions');await click('收起侧边栏');await checkSessionRows(1440,'production-session-list-collapsed-light');await navigate('/worlds/browser-world');await until('!!document.querySelector("[data-world-section=会话]")');await click('会话');await checkSessionRows(1440,'production-world-sessions-light');
 await navigate('/sessions/'+manifest['custom-world']);const custom=await frameUntil('!!document.querySelector("[data-custom-status]")');assert(await custom('!document.querySelector(".sr-story")'),'Injected WorldStory into author stage');await custom('document.querySelector("button").click()');await until('document.querySelector("[contenteditable]")?.innerText.includes("来自作者舞台")');await shot('production-custom-stage');
 await navigate('/sessions/'+manifest['missing-main']);await frameUntil('document.body.innerText.includes("暮色落下")&&!document.querySelector("[data-component-badge]")');await until('document.body.innerText.includes("未找到舞台主组件")');
 await navigate('/sessions/'+manifest['broken-message']);await frameUntil('document.body.innerText.includes("暮色落下")&&!document.querySelector("[data-component-badge]")');
 await navigate('/worlds/broken-preview');await until('document.body.innerText.includes("组件加载失败")');await click('重试');await until('document.body.innerText.includes("组件加载失败")');await click('开局');await frameUntil('!!document.querySelector("[data-opening-preview]")','iframe[data-world-component]');
 for(const id of ['broken-main','old-sdk']){await navigate('/sessions/'+manifest[id]);await until('!!document.querySelector(".stage-error")');assert(await evaluate('!document.querySelector("iframe[title=会话页面]")'),'Invalid author stage silently fell back');}
 await checkDensity({call,evaluate,until,navigate,click,shot,assert,pointer,key,frameUntil});
 await checkModels({origin,call,evaluate,until,navigate,click,shot,assert,setTheme});
 await checkSettings({call,evaluate,until,navigate,click,shot,assert,setTheme});
 assert(exceptions.length===0,'Browser exceptions: '+exceptions.join('\n'));
 await navigate('/worlds');
 await navigate('/worlds/browser-world');await until('!!document.querySelector("[data-role-strip]")');
 assert(await evaluate('document.querySelector("[data-role-card=player] [data-role-action=select]").getAttribute("aria-pressed")==="true"'),'Role choice persisted after leaving the world');
 console.log('PASS: real API/SSE/session create/send/stop/reload, component modules, SDK draft, preset persistence, models/settings, missing main/message fallback, broken entry/old SDK rejection, readonly world state, denied scopes/HTTP/Session API, preview switch/unmount/error/retry, opening regex bypass, collapsed header clearance, aligned opening actions, shared select keyboard/persistence/dialog focus, 1280/375, sandbox and screenshots');
 }
}catch(error){console.error(error);if(exceptions.length)console.error(exceptions.join('\n'));process.exitCode=1;}finally{ws?.close();for(const child of children.reverse())child.kill('SIGTERM');await imageServer?.close();await delay(500);await rm(temporary,{recursive:true,force:true});}
