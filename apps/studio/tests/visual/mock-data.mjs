/** Run with the Studio mock server: STUDIO_URL=http://127.0.0.1:5174 node tests/visual/mock-data.mjs */
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const profile=await mkdtemp(join(tmpdir(),'sr-world-api-'));
const chrome=process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const base=process.env.STUDIO_URL||'http://127.0.0.1:5174';
const output=resolve('tests/visual/output');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let browser,ws,id=0,errors=0;
const pending=new Map();
const send=(method,params={})=>new Promise((resolve,reject)=>{const request=++id;pending.set(request,{resolve,reject});ws.send(JSON.stringify({id:request,method,params}));});
const evaluate=async expression=>(await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result?.value;
const until=async expression=>{for(let n=0;n<80;n++){if(await evaluate(expression))return;await delay(100);}throw Error('Timed out: '+expression);};
const assert=(condition,message)=>{if(!condition)throw Error(message);};
try{
  await mkdir(output,{recursive:true});
  browser=spawn(chrome,['--headless=new','--no-first-run','--disable-gpu','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
  let port;for(let i=0;i<80;i++){try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch{await delay(100);}}
  if(!port)throw Error('Chrome failed to start');
  const tab=(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p=>p.type==='page');
  ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise((ok,fail)=>{ws.addEventListener('open',ok,{once:true});ws.addEventListener('error',fail,{once:true});});
  ws.addEventListener('message',event=>{const msg=JSON.parse(event.data);if(msg.method==='Runtime.exceptionThrown')errors++;if(msg.id){const p=pending.get(msg.id);if(p){pending.delete(msg.id);msg.error?p.reject(Error(JSON.stringify(msg.error))):p.resolve(msg.result);}}});
  await send('Page.enable');await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await send('Page.navigate',{url:base+'/worlds'});
  await until('document.querySelectorAll(\'[aria-label^="查看世界卡："]\').length===20');
  assert(await evaluate('document.querySelector("main").innerText.includes("模拟数据")'),'mock worlds must be labelled');
  await evaluate('document.querySelector(\'[aria-label^="查看世界卡："]\').click()');
  await until('!!document.querySelector("[data-world-content]")');
  assert(await evaluate('document.querySelector("[data-world-overview]").innerText.includes("模拟数据")'),'mock detail must be labelled');
  await send('Page.navigate',{url:base+'/sessions'});
  await until('document.querySelectorAll(\'main a[href^="/sessions/"]\').length===20');
  await send('Page.navigate',{url:base+'/presets'});
  await until('document.querySelectorAll("[data-preset-item]").length===10');
  assert(errors===0,`browser exceptions: ${errors}`);
  console.log('PASS: 20 mock worlds, 20 sessions, 10 presets and mock world detail');
}finally{ws?.close();browser?.kill('SIGTERM');await delay(200);await rm(profile,{recursive:true,force:true});}
