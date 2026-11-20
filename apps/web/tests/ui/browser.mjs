import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'sr-detail-overlay-'));const out=join(dir,'screens');await mkdir(out);
const pause=ms=>new Promise(r=>setTimeout(r,ms));const origin=process.env.WEB_URL??'http://127.0.0.1:5176';
const data=async path=>(await(await fetch(origin+'/api/v1/'+path)).json()).data;
const world=(await data('worlds?limit=1')).items[0],preset=(await data('presets?limit=1')).items[0],model=(await data('api-model-configs')).items[0];
if(!world||!preset||!model)throw Error('Missing existing read-only verification data');
const chrome=spawn(process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=0','--user-data-dir='+join(dir,'chrome'),'about:blank'],{stdio:'ignore'});
let ws,sequence=0;const pending=new Map(),errors=[];
const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
async function until(expression){for(let i=0;i<100;i++){if(await evaluate(expression))return;await pause(100);}throw Error('Timeout: '+expression);}
const assert=(v,message)=>{if(!v)throw Error(message);};
async function shot(name){await pause(250);const r=await call('Page.captureScreenshot',{format:'png'});await writeFile(join(out,name+'.png'),Buffer.from(r.data,'base64'));}
async function click(label){await evaluate(`(()=>{const e=[...document.querySelectorAll('button,a')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)}||e.textContent.trim()===${JSON.stringify(label)});if(!e)throw Error('Missing control');e.click()})()`);}
try{
 let port;for(let i=0;i<60;i++){try{port=Number((await readFile(join(dir,'chrome/DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch{await pause(100);}}
 const tab=(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(t=>t.type==='page');ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
 ws.addEventListener('message',e=>{const d=JSON.parse(e.data);if(d.method==='Runtime.exceptionThrown')errors.push(d.params.exceptionDetails.exception?.description||d.params.exceptionDetails.text);if(d.id){const p=pending.get(d.id);pending.delete(d.id);d.error?p?.reject(Error(d.error.message)):p?.resolve(d.result);}});
 await call('Page.enable');await call('Runtime.enable');
 // Read-only UI checks: no model calls, form saves, imports or fixture writes.
 for(const mode of ['light','dark']){
  for(const width of [320,375,820,1280]){
   await call('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:width<=760});
   let anchor;
   for(const kind of ['worlds','presets','sessions','models','settings']){
    await call('Page.navigate',{url:origin+'/'+kind});await until('!!document.querySelector("[data-page-header] h1")');
    await evaluate(`import('/src/styles/theme.ts').then(m=>m.setTheme(m.builtinTheme('${mode}')))`);await pause(100);
    const geometry=await evaluate(`(()=>{const title=document.querySelector('[data-page-header] h1'),r=title.getBoundingClientRect(),style=getComputedStyle(title);return {x:r.x,y:r.y,size:style.fontSize,line:style.lineHeight,overflow:document.documentElement.scrollWidth>innerWidth,buttons:[...document.querySelectorAll('.sr-page-actions .sr-button')].map(b=>({height:b.getBoundingClientRect().height,bottom:b.getBoundingClientRect().bottom,right:b.getBoundingClientRect().right}))}})()`);
    assert(!geometry.overflow,'Main page overflows: '+kind+' '+width);
    if(!anchor)anchor=geometry;
    assert(Math.abs(geometry.x-anchor.x)<1&&Math.abs(geometry.y-anchor.y)<1&&geometry.size===anchor.size&&geometry.line===anchor.line,'Title anchor mismatch: '+kind+' '+width+' '+JSON.stringify({anchor,geometry}));
    assert(geometry.buttons.every(b=>b.height>=(width<=760?44:40)&&b.right<=width),'Header action geometry: '+kind+' '+width);
    if(kind==='presets'&&geometry.buttons.length>1)assert(geometry.buttons[0].height===geometry.buttons[1].height,'Preset actions unequal');
    if(width===375||width===1280)await shot(kind+'-main-'+mode+'-'+width);
   }
  }
 }
 // Select keyboard dismissal and dialog focus restoration, without saving.
 await call('Page.navigate',{url:origin+'/settings'});await until('!!document.querySelector("[role=combobox][aria-label=主题]")');
 await evaluate(`document.querySelector('[role=combobox][aria-label=主题]').focus()`);
 await call('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown'});await until('!!document.querySelector("[role=listbox]")');
 await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await until('!document.querySelector("[role=listbox]")');
 assert(await evaluate(`document.activeElement.getAttribute('aria-label')==='主题'`),'Select lost focus');
 await call('Page.navigate',{url:origin+'/models'});await until('!!document.querySelector("[data-page-header] button")');
 await evaluate(`document.querySelector('[data-page-header] button').focus()`);await click('添加模型');await until('!!document.querySelector("[role=dialog]")');await shot('model-dialog');
 assert(await evaluate(`document.querySelector('[role=dialog]').contains(document.activeElement)`),'Dialog has no focused child');
 await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await until('!document.querySelector("[role=dialog]")');
 assert(await evaluate(`document.activeElement.textContent.includes('添加模型')`),'Dialog did not restore focus');

 for(const width of [375,320,1280,820]){
  await call('Emulation.setDeviceMetricsOverride',{width,height:width===320?600:850,deviceScaleFactor:1,mobile:width<=760});
  for(const [kind,id,ready] of [['worlds',world.id,'!!document.querySelector("[data-world-viewport]")'],['presets',preset.id,'!!document.querySelector("[aria-label=预设名称]")'],['models',model.id,'!!document.querySelector("[aria-label=模型配置详情] h2")']]){
   await call('Page.navigate',{url:origin+'/'+kind+'/'+encodeURIComponent(id)});await until(ready);await pause(350);
   const nav=await evaluate(`(()=>{const n=document.querySelector('nav[aria-label=手机主导航]');return {visible:!!n&&getComputedStyle(n).display!=='none',active:n?.querySelector('[aria-current=page]')?.getAttribute('href'),top:n?.getBoundingClientRect().top}})()`);
   assert(nav.visible===(width<=760),'Navigation visibility '+kind+' '+width);
   if(width<=760){
    assert(nav.active==='/'+kind,'Selected section '+kind);
    const fits=await evaluate(`(()=>{const selector=${JSON.stringify(kind==='worlds'?'[data-world-viewport]':kind==='presets'?'[data-preset-workspace]':'[data-model-workspace]')};const r=document.querySelector(selector).getBoundingClientRect();return r.bottom>${nav.top}&&Math.abs(r.bottom-innerHeight)<2&&document.documentElement.scrollWidth<=innerWidth})()`);assert(fits,'Detail viewport no longer extends behind navigation '+kind+' '+width);
    assert(await evaluate(`![...document.querySelectorAll('button,a')].some(e=>['返回世界卡列表','返回预设列表'].includes(e.getAttribute('aria-label'))&&e.getBoundingClientRect().width>0||e.textContent.trim()==='返回模型列表'&&e.getBoundingClientRect().width>0)`),'Back button remains '+kind);
   }
   if(kind==='worlds'){
    assert(await evaluate(`(()=>{const cover=document.querySelector('[data-world-overview] h1').parentElement.parentElement.firstElementChild.getBoundingClientRect(),more=document.querySelector('[aria-label=世界卡更多操作]').getBoundingClientRect(),title=document.querySelector('[data-world-overview] h1').getBoundingClientRect();return Math.abs(cover.top-more.top)<2&&title.right<=more.left-4})()`),'Expanded header misaligned or overlaps');
    await shot('world-expanded-'+width);
    await click('开局');await pause(250);
    assert(await evaluate(`(()=>{const prev=document.querySelector('[aria-label="上一个开局"]'),next=document.querySelector('[aria-label="下一个开局"]'),state=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='查看初始状态'),start=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='开始会话');if(!prev)return true;const controls=[prev,next,state,start].filter(Boolean).map(b=>b.getBoundingClientRect());return controls.every(r=>r.width>=40&&r.height>=${width<=760?44:32}&&Math.abs((r.top+r.height/2)-(controls[0].top+controls[0].height/2))<2&&r.right<=Math.min(innerWidth,prev.parentElement.parentElement.getBoundingClientRect().right)+1)})()`),'Opening toolbar wrap or undersized targets '+width);
    await shot('world-opening-'+width);
    if(await evaluate(`!!document.querySelector('[aria-label=收起世界概览]')`))await click('收起世界概览');await until('Number(document.querySelector("[data-collapse-progress]").dataset.collapseProgress)>.99');await click('运行配置');await until('document.querySelectorAll("[data-world-content] [role=combobox]").length===2');
    assert(await evaluate(`(()=>{const e=document.querySelector('[data-world-content]');return !e.querySelector('h3')&&!e.querySelector('a')&&!e.textContent.includes('用于此世界')})()`),'Redundant world configuration content');
    if(width<=760)assert(await evaluate(`Math.abs(document.querySelector('[data-world-viewport]').getBoundingClientRect().bottom-innerHeight)<2`),'Collapsed world viewport overlaps navigation');
   }
   if(kind==='models'&&width===820)assert(await evaluate(`getComputedStyle([...document.querySelectorAll('a')].find(e=>e.textContent.trim()==='返回模型列表')).display!=='none'`),'Tablet return path lost');
   if(width<=760){
    const paneSelector=kind==='worlds'?'[data-world-content]':kind==='presets'?'[data-preset-content]':'[aria-label=模型配置详情]>div';
    assert(await evaluate(`(()=>{const p=document.querySelector(${JSON.stringify(paneSelector)}),r=p.getBoundingClientRect();return r.bottom>${nav.top}&&parseFloat(getComputedStyle(p).paddingBottom)>=100})()`),'Scroll pane is clipped or lacks tail: '+kind);
    if(kind==='worlds'){await click('世界状态');await pause(350);}
    await shot(kind+'-behind-nav-'+width);
    await evaluate(`document.querySelector(${JSON.stringify(paneSelector)}).scrollTo({top:1000000,behavior:'instant'})`);await pause(150);
    const end=await evaluate(`(()=>{const p=document.querySelector(${JSON.stringify(paneSelector)}),last=p.lastElementChild,r=last.getBoundingClientRect();return {bottom:r.bottom,navTop:document.querySelector('nav[aria-label=手机主导航]').getBoundingClientRect().top,scroll:p.scrollTop,max:p.scrollHeight-p.clientHeight}})()`);
    assert(end.bottom<=end.navTop-8,'Last content cannot clear navigation: '+kind+' '+JSON.stringify(end));
   }
   await shot(kind+'-'+width);
   if(width<=760){await evaluate(`document.querySelector('nav[aria-label=手机主导航] a[href="/${kind}"]').click()`);await until('location.pathname==='+JSON.stringify('/'+kind));}
  }
 }
 // Same-mode custom themes must reach an existing renderer without reloading it.
 await call('Page.navigate',{url:origin+'/worlds/'+encodeURIComponent(world.id)});await until('!!document.querySelector("iframe[src*=world-component]")');await pause(700);
 const tree=await call('Page.getFrameTree');
 const findFrame=node=>node.frame.url.includes('world-component.html')?node.frame:(node.childFrames??[]).map(findFrame).find(Boolean);
 const preview=findFrame(tree.frameTree);assert(preview,'Missing world preview frame');
 const context=await call('Page.createIsolatedWorld',{frameId:preview.id,worldName:'ui-appearance-test'});
 const frameRead=async expression=>(await call('Runtime.evaluate',{expression,contextId:context.executionContextId,returnByValue:true})).result.value;
 for(const accent of ['#8ebfca','#c5a3db']){
  await evaluate(`import('/src/styles/theme.ts').then(m=>m.setTheme({...m.builtinTheme('dark'),id:'verification',colors:{accent:'${accent}'}}))`);await pause(150);
  assert(await frameRead(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()` )===accent,'Preview did not receive same-mode theme');
 }
 await evaluate(`import('/src/styles/theme.ts').then(m=>m.setTheme(m.builtinTheme('dark')))`);
 const session=(await data('sessions?limit=1')).items[0];
 if(session){
  await call('Page.navigate',{url:origin+'/sessions'});await until('!!document.querySelector("[data-session-row]")');
  await evaluate(`document.querySelector('[data-session-actions] button').focus();document.querySelector('[data-session-actions] button').click()`);await until('!!document.querySelector("[role=dialog]")');
  assert(await evaluate(`document.querySelector('[role=dialog]').textContent.includes('确认删除')`),'Delete confirmation missing');
  await click('取消');await until('!document.querySelector("[role=dialog]")');
  await call('Page.navigate',{url:origin+'/sessions/'+encodeURIComponent(session.id)});await until('!!document.querySelector("iframe[title=会话页面]")');await pause(1000);
  const stageTree=await call('Page.getFrameTree');
  const findStage=node=>new URL(node.frame.url).pathname==='/frame.html'?node.frame:(node.childFrames??[]).map(findStage).find(Boolean);
  const stage=findStage(stageTree.frameTree);assert(stage,'Missing stage frame');
  const stageContext=await call('Page.createIsolatedWorld',{frameId:stage.id,worldName:'ui-stage-test'});
  for(const mode of ['light','dark']){
   await evaluate(`import('/src/styles/theme.ts').then(m=>m.setTheme(m.builtinTheme('${mode}')))`);await pause(200);
   const expected=await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--reading-border').trim()`);
   const actual=(await call('Runtime.evaluate',{expression:`getComputedStyle(document.documentElement).getPropertyValue('--sr-story-line').trim()`,contextId:stageContext.executionContextId,returnByValue:true})).result.value;
   assert(actual===expected,'WorldStory border appearance mismatch');
  }
 }
 assert(errors.length===0,'Browser exceptions: '+errors.join('\n'));
 console.log('PASS: five main headers in both themes at 320/375/820/1280; Select/dialog keyboard focus; opening toolbar; all three detail overlay/tail layouts; preview and available session stage theme bridges.');console.log('Screenshots: '+out);
}catch(error){await shot('failure').catch(()=>{});console.error(error);console.log('Screenshots: '+out);process.exitCode=1;}
finally{ws?.close();chrome.kill('SIGTERM');await pause(400);await rm(join(dir,'chrome'),{recursive:true,force:true});}
