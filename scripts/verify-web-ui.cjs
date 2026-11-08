#!/usr/bin/env node
/**
 * Read-only UI smoke verification. Uses installed Chrome CDP; does not send
 * mutations or change the user's world card, session, app settings or keys.
 * Run: node scripts/verify-web-ui.cjs (with SR_WEB_URL when needed).
 */
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const base=process.env.SR_WEB_URL||'http://127.0.0.1:3000';
const chrome=process.env.SR_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const timeout=process.env.SR_UI_WAIT?Number(process.env.SR_UI_WAIT):1600;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const assert=(ok,text)=>{if(!ok)throw Error(text)};
async function main(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sr-web-ui-smoke-'));
 const port=9255;
 const proc=spawn(chrome,['--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-gpu','--remote-allow-origins=*','--remote-debugging-port='+port,'--user-data-dir='+root,'about:blank'],{stdio:'ignore'});
 let ws;
 try {
   let pages;
   for(let i=0;i<80;i++){try{pages=await(await fetch('http://127.0.0.1:'+port+'/json')).json();if(pages.find(p=>p.type==='page'))break;}catch{}await sleep(150);}
   assert(pages?.length,'Chrome CDP did not start');
   ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
   await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
   let id=0;const pending=new Map();
   ws.onmessage=event=>{const msg=JSON.parse(event.data);if(pending.has(msg.id)){const [resolve,reject]=pending.get(msg.id);pending.delete(msg.id);msg.error?reject(Error(JSON.stringify(msg.error))):resolve(msg.result);}};
   const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,[resolve,reject]);ws.send(JSON.stringify({id:n,method,params}));setTimeout(()=>{if(pending.has(n)){pending.delete(n);reject(Error('Timeout: '+method));}},10000);});
   await call('Page.enable');await call('Runtime.enable');
   const meta=(await(await fetch(base+'/api/v1/worlds?limit=1')).json()).data;
   const sessions=(await(await fetch(base+'/api/v1/sessions?limit=1')).json()).data;
   const presets=(await(await fetch(base+'/api/v1/presets?limit=1')).json()).data;
   const worlds=meta?.items??[];
   const routes=[['会话','/sessions','会话'],['世界库','/worlds','世界库'],['预设','/presets','预设'],['模型连接','/providers','模型连接'],['设置','/settings','设置'],['首次配置','/setup','模型']];
   if(worlds[0])routes.push(['世界详情','/worlds/'+worlds[0].id,'世界介绍']);
   if(sessions.items?.[0])routes.push(['会话运行','/sessions/'+sessions.items[0].id,'发送']);
   if(presets.items?.[0])routes.push(['预设编辑','/presets/'+presets.items[0].id,'保存更改']);
   let checks=0;
   for(const width of [1280,375]){
     for(const [label,route,text] of routes){
       await call('Emulation.setDeviceMetricsOverride',{width,height:width===375?812:900,deviceScaleFactor:1,mobile:width===375});
       await call('Page.navigate',{url:base+route});
       await sleep(timeout+(route.startsWith('/worlds/')?450:0));
       const result=await call('Runtime.evaluate',{returnByValue:true,expression:`JSON.stringify({body:document.body.innerText.slice(0,4000),vw:innerWidth,documentWidth:document.documentElement.scrollWidth,main:!!document.querySelector('.app-shell'),bad:!!document.querySelector('.host-fatal'),button:Array.from(document.querySelectorAll('button,a')).some(e=>e.textContent.includes(${JSON.stringify(text)}))})`});
       const info=JSON.parse(result.result.value);
       assert(info.main,label+' @ '+width+': app did not mount');
       assert(info.documentWidth<=info.vw+2,label+' @ '+width+': horizontal overflow '+info.documentWidth+' > '+info.vw);
       assert(info.body.includes(text)||info.button,label+' @ '+width+': no expected text '+text);
       assert(!info.bad,label+' @ '+width+': session host fatal');
       const toggles={
         '模型连接':['.models-page .page-heading .button.primary','.model-dialog'],
         '世界详情':['.detail-tabs button:nth-child(2)','.opening-preview'],
         '会话运行':['.hostbar .host-actions button:last-child','.host-settings'],
         '预设编辑':['.editor-node-expand','.editor-node-content'],
         '设置':['.settings-theme-choice:nth-child(2)',':root[data-theme="dark"]']
       };
       if(toggles[label]){
         const [clickSelector,expectSelector]=toggles[label];
         const clicked=await call('Runtime.evaluate',{returnByValue:true,expression:`(()=>{const item=document.querySelector(${JSON.stringify(clickSelector)});if(!item)return false;item.click();return true;})()`});
         assert(clicked.result.value,label+' @ '+width+': interaction control missing: '+clickSelector);
         await sleep(180);
         const toggled=await call('Runtime.evaluate',{returnByValue:true,expression:`!!document.querySelector(${JSON.stringify(expectSelector)})`});
         assert(toggled.result.value,label+' @ '+width+': interaction did not open '+expectSelector);
         checks++;
       }
       if(width===375){
         const drawerControl=await call('Runtime.evaluate',{returnByValue:true,expression:`(()=>{const menu=document.querySelector('.mobile-menu');if(!menu)return false;menu.click();return true;})()`});
         assert(drawerControl.result.value,label+' @ '+width+': navigation menu missing');
         await sleep(160);
         const drawer=await call('Runtime.evaluate',{returnByValue:true,expression:`!!document.querySelector('.mobile-drawer')`});
         assert(drawer.result.value,label+' @ '+width+': navigation drawer did not open');
         checks++;
       }
       checks++;console.log('PASS',width,label);
     }
   }
   console.log('PASS',checks,'read-only UI route and overflow checks');
 }finally {
   ws?.close();
   proc.kill('SIGTERM');
   await sleep(400);
   try{fs.rmSync(root,{recursive:true,force:true});}catch{}
 }
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
