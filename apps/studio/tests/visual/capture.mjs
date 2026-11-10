/**
 * Minimal CDP visual smoke test using installed Google Chrome; no browser-test framework needed.
 * Start 'pnpm --filter @sillyrealms/studio dev' first.
 * Output screenshots are local and ignored by Git.
 */
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

const base=process.env.STUDIO_URL || 'http://127.0.0.1:5174';
const chromePath=process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const out=resolve('tests/visual/output');
const profile=await mkdtemp(join(tmpdir(),'sr-studio-chrome-'));
const delay=(ms)=>new Promise(r=>setTimeout(r,ms));
let browser;
let conn;
let id=1;
const pend=new Map();
let exceptionCount=0;
try{
  await mkdir(out,{recursive:true});
  browser=spawn(chromePath,[
    '--headless=new','--no-first-run','--no-default-browser-check','--disable-gpu',
    '--hide-scrollbars','--remote-debugging-port=0','--force-device-scale-factor=1',
    '--window-size=1536,864','--user-data-dir='+profile,'about:blank'
  ],{stdio:'ignore'});
  let port;
  for(let i=0;i<70;i++){
    try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);break;}
    catch{await delay(150);}
  }
  if(!port)throw new Error('Chrome CDP did not start');
  const pages=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
  const page=pages.find(p=>p.type==='page');
  if(!page?.webSocketDebuggerUrl)throw new Error('Missing Chrome page');
  conn=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res,rej)=>{conn.addEventListener('open',res,{once:true});conn.addEventListener('error',rej,{once:true});});
  conn.addEventListener('message',e=>{
    const data=JSON.parse(e.data);
    if(data.method==='Runtime.exceptionThrown')exceptionCount++;
    if(data.id){
      const task=pend.get(data.id);if(!task)return;
      pend.delete(data.id);
      data.error?task.reject(new Error(JSON.stringify(data.error))):task.resolve(data.result);
    }
  });
  function send(method,params={}){
    const req=id++;
    return new Promise((resolve,reject)=>{
      pend.set(req,{resolve,reject});
      conn.send(JSON.stringify({id:req,method,params}));
    });
  }
  async function evaluate(expression){
    const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);
    return r.result?.value;
  }
  async function until(expression,timeout=10000){
    for(let elapsed=0;elapsed<timeout;elapsed+=150){
      if(await evaluate(expression))return;
      await delay(150);
    }
    throw new Error('Timeout: '+expression);
  }
  async function viewport(width,height,mobile=false){
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile});
  }
  async function navigate(url){
    await send('Page.navigate',{url});
    await until("document.readyState === 'complete' && document.querySelectorAll('[aria-label^=\"查看世界卡\"]').length >= 1 && [...document.images].every(img=>img.complete)");
    await delay(420);
  }
  async function screenshot(name){
    const {data}=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile(join(out,name+'.png'),Buffer.from(data,'base64'));
  }
  const click=async selector=>{
    const okay=await evaluate('(()=>{const el=document.querySelector('+JSON.stringify(selector)+');if(!el)return false;el.click();return true})()');
    if(!okay)throw new Error('No element: '+selector);
    await delay(280);
  };
  const assert=(condition,message)=>{if(!condition)throw new Error(message);};

  await send('Page.enable');await send('Runtime.enable');
  await viewport(1536,864);
  await navigate(base+'/worlds?sidebar=expanded&theme=dark');
  assert(await evaluate('document.querySelectorAll("[aria-label^=\\"查看世界卡\\"]").length')===8,'Expected 8 cards');
  await screenshot('home-expanded-1536');
  await click('[aria-label="收起侧边栏"]');
  assert(await evaluate('document.querySelector("[data-collapsed]").dataset.collapsed')==='true','Sidebar did not collapse');
  await screenshot('home-collapsed-1536');
  await click('[aria-label="展开侧边栏"]');
  assert(await evaluate('document.querySelector("[data-collapsed]").dataset.collapsed')==='false','Sidebar did not expand');
  await click('button[aria-label="设置"]');
  assert(await evaluate('!!document.querySelector("[role=dialog]")'),'Settings dialog not opened');
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  await until('!document.querySelector("[role=dialog]")');
  await click('button[aria-label="切换亮色主题"]');
  assert(await evaluate('document.documentElement.dataset.theme')==='light','Theme did not switch');
  await click('button[aria-label="切换暗色主题"]');
  await click('nav[aria-label="世界分类"] button:nth-child(2)');
  assert(await evaluate('document.querySelectorAll("[aria-label^=\\"查看世界卡\\"]").length')===2,'Filtering failed');
  await click('nav[aria-label="世界分类"] button:nth-child(1)');
  await click('button[aria-label="查看世界卡：长安风云"]');
  assert(await evaluate('!!document.querySelector("[role=dialog]")'),'World detail dialog not opened');
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  await until('!document.querySelector("[role=dialog]")');
  await viewport(390,844,true);
  await navigate(base+'/worlds?sidebar=expanded&theme=dark');
  await screenshot('home-mobile-390');
  await click('[aria-label="打开导航"]');
  assert(await evaluate('document.querySelector("[aria-label=\\"关闭导航\\"]") !== null'),'Mobile menu missing');
  await screenshot('home-mobile-menu-390');
  assert(exceptionCount===0,'Browser JS exceptions: '+exceptionCount);
  console.log('PASS: desktop expanded/collapsed, eight cards, settings dialog/Escape, theme, category, card detail, mobile menu.');
  console.log('Screenshots:',out);
}catch(e){
  console.error('FAIL:',e);
  process.exitCode=1;
}finally{
  if(conn?.readyState===WebSocket.OPEN)conn.close();
  if(browser)browser.kill();
  await delay(250);
  await rm(profile,{recursive:true,force:true}).catch(()=>{});
}
