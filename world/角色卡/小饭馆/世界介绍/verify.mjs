// Local artifact checks, no database, Provider requests or app changes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const chrome=process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const preview=fs.readFileSync(path.join(dir,'index.html'),'utf8');
const script=`<script>
window.addEventListener('load',async()=>{
 try{
 const results=[];const errors=[];window.addEventListener('error',e=>errors.push(e.message));
 const wait=()=>new Promise(r=>setTimeout(r,100));const check=(name,ok)=>results.push({name,pass:!!ok});
 await wait();
 check('首屏与介绍已挂载',document.querySelector('h1')?.textContent==='小饭馆');
 check('无水平溢出',document.documentElement.scrollWidth<=innerWidth);
 check('所有可见图片可读取',[...document.images].every(i=>i.complete&&i.naturalWidth>0));
 document.querySelector('.xf-cta').click();await wait();
 check('认识人物后焦点进入人物区域',document.activeElement===document.querySelector('.xf-people'));
 for(const name of ['掌柜','李鸟儿','李鱼儿']){
  const b=[...document.querySelectorAll('.xf-personbutton')].find(b=>b.textContent===name);b.focus();b.click();await wait();
  check(name+'切换及选中状态',document.querySelector('.xf-person h3')?.textContent===name&&b.getAttribute('aria-pressed')==='true'&&document.querySelectorAll('[aria-pressed=true]').length===1);
  check(name+'头像加载',document.querySelector('.xf-portrait img')?.naturalWidth>0);
  check(name+'保持焦点与可访问名称',document.activeElement===b&&b.tagName==='BUTTON');
 }
 const image=document.querySelector('.xf-portrait img');image.dispatchEvent(new Event('error'));await wait();
 check('图片错误可见回退',document.querySelector('.xf-portrait .xf-fallback')?.textContent.includes('图片暂不可用'));
 document.querySelector('.xf-personbutton').click();await wait();
 check('切换人物后恢复图片',document.querySelector('.xf-portrait img')?.naturalWidth>0);
 const taps=[...document.querySelectorAll('button')].every(b=>{const r=b.getBoundingClientRect();return r.width>=44&&r.height>=44});check('点击目标至少44px',taps);
 check('运行无未捕获异常',errors.length===0);
 parent.postMessage({type:'xf-test-results',width:innerWidth,results},'*');
 }catch(error){parent.postMessage({type:'xf-test-results',width:innerWidth,results:[{name:String(error),pass:false}]},'*')}
});</script>`;
const csp=`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;">`;
const child=preview.replace('<head>','<head>'+csp).replace('</body>',script+'</body>');
const escaped=child.replaceAll('&','&amp;').replaceAll('"','&quot;');
const wrapper=`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}iframe{width:100%;height:100vh;border:0}</style><iframe sandbox="allow-scripts" srcdoc="${escaped}"></iframe><pre id="results">pending</pre><script>const frame=document.querySelector('iframe');window.addEventListener('message',e=>{if(e.source===frame.contentWindow&&e.data?.type==='xf-test-results')document.getElementById('results').textContent=JSON.stringify(e.data)});</script>`;
const server=http.createServer((req,res)=>{const width=Number(new URL(req.url,'http://localhost').searchParams.get('width'));res.writeHead(200,{'content-type':'text/html;charset=utf-8'});res.end(wrapper.replace('<iframe ',`<iframe style="width:${[1280,375,320].includes(width)?width:1280}px" `))});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const all=[];
try{
 for(const width of [1280,375,320]){
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'xf-verify-'));
  try{
   const args=['--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-sync','--hide-scrollbars','--force-prefers-reduced-motion','--force-device-scale-factor=1','--user-data-dir='+profile,'--window-size='+width+',812','--remote-debugging-port=0','http://127.0.0.1:'+server.address().port+'/?width='+width];
   const browser=spawn(chrome,args,{stdio:'ignore'});let ws;let value;
   const sleep=ms=>new Promise(r=>setTimeout(r,ms));
   try{
    let port;for(let n=0;n<100&&!port;n++){await sleep(100);try{port=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0])}catch{}}
    if(!port)throw Error('Chrome debugging port unavailable');
    const tabs=await(await fetch('http://127.0.0.1:'+port+'/json')).json();
    ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
    await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})});
    let id=0;const pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id)}});
    const send=(method,params)=>new Promise(r=>{const i=++id;pending.set(i,r);ws.send(JSON.stringify({id:i,method,params}))});
    for(let n=0;n<150;n++){const result=await send('Runtime.evaluate',{expression:'document.getElementById("results")?.textContent',returnByValue:true});value=result.result?.result?.value;if(value&&value!=='pending')break;await sleep(100)}
    if(!value||value==='pending')throw Error('No iframe test results');
   }finally{ws?.close();browser.kill();await new Promise(r=>browser.exitCode!==null?r():browser.once('exit',r))}
   const result=JSON.parse(value);
   // Headless Chrome has a minimum native window width; the iframe is explicitly sized below.
   all.push({...result,requestedWidth:width});console.log(JSON.stringify(all.at(-1)));
  }finally{fs.rmSync(profile,{recursive:true,force:true})}
 }
}finally{await new Promise(r=>server.close(r))}
fs.writeFileSync(path.join(dir,'验证/interaction-results.json'),JSON.stringify(all,null,2)+'\n');
if(all.some(r=>r.results.some(t=>!t.pass)))process.exitCode=1;
