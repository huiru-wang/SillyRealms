// Browser regressions use a fake API/SSE and the real isolated session iframe.
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';

const webDir=fileURLToPath(new URL('../..',import.meta.url));
const chromePath=process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile=await mkdtemp(join(tmpdir(),'sr-composer-test-'));
const port = await new Promise((resolve,reject)=>{const probe=createServer();probe.once('error',reject);probe.listen(0,'127.0.0.1',()=>{const port=probe.address().port;probe.close(()=>resolve(port));});});
const server=spawn(join(webDir,'node_modules/.bin/vite'),['--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd:webDir,stdio:'ignore'});
const browser=spawn(chromePath,['--headless','--disable-gpu','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try {
  const debugging=await new Promise((resolve,reject)=>{
    let output='';const timer=setTimeout(()=>reject(new Error('Chrome failed to start')),15000);
    browser.on('error',error=>{clearTimeout(timer);reject(error)});
    browser.stderr.on('data',chunk=>{output+=chunk;const match=output.match(/DevTools listening on ws:\/\/(127\.0\.0\.1:\d+)\//);if(match){clearTimeout(timer);resolve(match[1]);}});
  });
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${port}/test/composer/`)).ok){ready=true;break;}}catch{}await pause(100);}
  if(!ready)throw new Error(`Vite failed to start on port ${port}`);
  const selected=process.env.SR_BROWSER_ONLY;
  for(const name of (selected?[selected]:['composer','host-roleplay'])){
    const page=await (await fetch(`http://${debugging}/json/new?http://127.0.0.1:${port}/test/${name}/`,{method:'PUT'})).json();
    const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
    let sequence=0;const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
      const id=++sequence;const onMessage=event=>{const response=JSON.parse(event.data);if(response.id!==id)return;ws.removeEventListener('message',onMessage);response.error?reject(Error(response.error.message)):resolve(response.result);};
      ws.addEventListener('message',onMessage);ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
    });
    try {
      await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
      await pause(100);
      let tests=[];
      if(name!=='worldstory-font'){
        for(let i=0;i<250;i++){
          const result=await call('Runtime.evaluate',{expression:'document.querySelector("#results")?.textContent || "[]"',returnByValue:true});
          tests=JSON.parse(result.result.value);if(tests.length>=(name==='host-roleplay'?8:7))break;await pause(100);
        }
        if(!tests.length)throw new Error(name+': browser tests did not start');
      }
      for(const test of tests)console.log(`${test.pass?'PASS':'FAIL'} ${name}: ${test.name}${test.error?`: ${test.error}`:''}`);
      if(tests.some(test=>!test.pass))process.exitCode=1;
      if(name==='host-roleplay'){
        for(const width of [1280,375]){
          await call('Emulation.setDeviceMetricsOverride',{width,height:812,deviceScaleFactor:1,mobile:width<600});
          await pause(180);
          const layout=await call('Runtime.evaluate',{returnByValue:true,expression:'JSON.stringify({width:document.documentElement.clientWidth,scrollWidth:document.querySelector(\".host\")?.scrollWidth,hostbar:document.querySelector(".hostbar")?.getBoundingClientRect().width,usage:document.querySelector(".host-usage")?.getBoundingClientRect().height,toggle:getComputedStyle(document.querySelector(".host-usage-toggle")).display,body:!!document.querySelector(".host-usage-body")})'});
          const metrics=JSON.parse(layout.result.value);
          if(metrics.scrollWidth>metrics.width+1||!metrics.usage){console.log('FAIL host-roleplay: '+width+'px token panel layout '+JSON.stringify(metrics));process.exitCode=1;}
          else console.log('PASS host-roleplay: '+width+'px token panel layout');
          if(width<600){
            const before=await call('Runtime.evaluate',{returnByValue:true,expression:'document.querySelector("iframe")?.getBoundingClientRect().height'});
            await call('Runtime.evaluate',{expression:'document.querySelector(".host-usage-toggle").click()'});
            await pause(100);
            const after=await call('Runtime.evaluate',{returnByValue:true,expression:'JSON.stringify({body:!!document.querySelector(".host-usage-body"),height:document.querySelector("iframe")?.getBoundingClientRect().height,position:getComputedStyle(document.querySelector(".host-usage")).position,bodyPosition:getComputedStyle(document.querySelector(".host-usage-body")).position})'});
            const expanded=JSON.parse(after.result.value);
            if(!expanded.body||expanded.height!==before.result.value||expanded.position!=='relative'||expanded.bodyPosition!=='absolute'){console.log('FAIL host-roleplay: mobile usage expansion changed layout '+JSON.stringify(expanded));process.exitCode=1;}
            else console.log('PASS host-roleplay: mobile usage expands as overlay without resizing story');
            await call('Runtime.evaluate',{expression:'document.querySelector(".host-usage-toggle").click()'});
            await call('Runtime.evaluate',{expression:'document.querySelector(".host-settings-button").click()'});await pause(100);
            const dialog=await call('Runtime.evaluate',{expression:'JSON.stringify((()=>{const r=document.querySelector(".host-settings-dialog").getBoundingClientRect();return {width:r.width,left:r.left,right:r.right,viewport:document.documentElement.clientWidth,scrollWidth:document.querySelector(".host").scrollWidth}})())',returnByValue:true});
            const dialogMetrics=JSON.parse(dialog.result.value);
            if(dialogMetrics.left<0||dialogMetrics.right>dialogMetrics.viewport+1||dialogMetrics.scrollWidth>dialogMetrics.viewport+1){console.log('FAIL host-roleplay: mobile settings dialog overflows '+JSON.stringify(dialogMetrics));process.exitCode=1;}
            else console.log('PASS host-roleplay: mobile settings dialog fits viewport');
            await call('Runtime.evaluate',{expression:'document.querySelector(".host-settings-dialog-footer .secondary").click()'});
          }
        }
        await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
      }
      if(name==='worldstory-font'){
        let frameSession=null,frameContextId=null,frameId=null;
        const iframeUrl=(await call('Runtime.evaluate',{expression:'document.querySelector("iframe")?.getAttribute("src")',returnByValue:true})).result.value;
        for(let i=0;i<150&&!frameSession&&!frameId;i++){
          const targets=await call('Target.getTargets');
          const nonce=typeof iframeUrl==='string'?iframeUrl.split('#').pop():'';
          const target=targets.targetInfos.find(item=>item.url.includes(nonce)&&item.url.includes('/frame.html'));
          if(target){const attached=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true});frameSession=attached.sessionId;await call('Runtime.enable',{},frameSession);}
          else {const tree=await call('Page.getFrameTree');const child=tree.frameTree.childFrames?.find(item=>item.frame.url.includes('/frame.html'));if(child)frameId=child.frame.id;}
          if(!frameSession&&!frameId)await pause(100);
        }
        if(!frameSession&&!frameId){
          const targets=await call('Target.getTargets');
          const tree=await call('Page.getFrameTree');
          const parent=await call('Runtime.evaluate',{expression:'JSON.stringify({iframe:document.querySelector("iframe")?.getAttribute("src"),fatal:document.querySelector(".host-fatal")?.textContent,host:document.querySelector(".host")?.innerText})',returnByValue:true});
          throw new Error('WorldStory iframe target was not found '+JSON.stringify({iframeUrl,targets:targets.targetInfos.map(item=>({type:item.type,url:item.url})),tree,parent:parent.result.value}));
        }
        if(frameId){const isolated=await call('Page.createIsolatedWorld',{frameId,worldName:'sr-font-regression',grantUniveralAccess:true});frameContextId=isolated.executionContextId;}
        const frameEval=async expression=>{
          const result=await call('Runtime.evaluate',{expression,returnByValue:true,...(frameContextId?{contextId:frameContextId}:{})},frameSession??undefined);
          if(result.exceptionDetails)throw new Error(result.exceptionDetails.text??'iframe evaluation failed');
          return result.result.value;
        };
        let rendered=0;
        for(let i=0;i<180;i++){rendered=Number(await frameEval('document.querySelectorAll(".sr-message").length').catch(()=>0));if(rendered===200)break;await pause(100);}
        if(rendered!==200)throw new Error('WorldStory did not render 200 messages; rendered '+rendered);
        for(const width of [1280,375]){
          await call('Emulation.setDeviceMetricsOverride',{width,height:812,deviceScaleFactor:1,mobile:width<600});await pause(180);
          const before=JSON.parse(await frameEval('JSON.stringify({count:document.querySelectorAll(".sr-message").length,fonts:[0,99,199].map(i=>getComputedStyle(document.querySelectorAll(".sr-message .sr-rich")[i]).fontSize),adjust:getComputedStyle(document.documentElement).getPropertyValue("-webkit-text-size-adjust")})'));
          const countChecks=JSON.parse(await frameEval('(()=>{const list=document.querySelector(".sr-chat-messages"),nodes=[...list.querySelectorAll(".sr-message")],result=[];for(const count of [5,50,200]){nodes.slice(count).forEach(node=>node.remove());const items=[...list.querySelectorAll(".sr-message .sr-rich")];result.push({count:items.length,fonts:[0,Math.floor((items.length-1)/2),items.length-1].map(index=>getComputedStyle(items[index]).fontSize)});nodes.slice(count).forEach(node=>list.appendChild(node));}return JSON.stringify(result)})()'));
          if(before.count!==200||before.fonts.some(value=>value!=='16px')||before.adjust.trim()!=='100%'||countChecks.some(item=>item.fonts.some(value=>value!=='16px'))){console.log('FAIL worldstory-font '+width+'px '+JSON.stringify({before,countChecks}));process.exitCode=1;}
          else console.log('PASS worldstory-font '+width+'px font stable at 5/50/200 messages');
          if(width===375){
            const anchorBefore=JSON.parse(await frameEval('(()=>{const c=document.querySelector(".sr-chat-messages"),m=document.querySelectorAll("[data-message-id]")[100];m.scrollIntoView({block:"start"});return JSON.stringify({id:m.getAttribute("data-message-id"),top:m.getBoundingClientRect().top-c.getBoundingClientRect().top})})()'));
            await call('Runtime.evaluate',{expression:'document.querySelector(".host-settings-button").click()'});await pause(100);
            await call('Runtime.evaluate',{expression:'(()=>{const e=document.querySelector(".host-reading-slider"),s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;s.call(e,"20");e.dispatchEvent(new Event("input",{bubbles:true}))})()'});await pause(200);
            const anchorAfterExpr='(()=>{const c=document.querySelector(".sr-chat-messages"),m=[...document.querySelectorAll("[data-message-id]")].find(x=>x.getAttribute("data-message-id")==='+JSON.stringify(anchorBefore.id)+');return JSON.stringify({id:m?.getAttribute("data-message-id"),top:m?m.getBoundingClientRect().top-c.getBoundingClientRect().top:null,font:getComputedStyle(document.querySelectorAll(".sr-message .sr-rich")[199]).fontSize})})()';
            const anchorAfter=JSON.parse(await frameEval(anchorAfterExpr));
            if(anchorAfter.id!==anchorBefore.id||Math.abs(anchorAfter.top-anchorBefore.top)>2||anchorAfter.font!=='20px'){console.log('FAIL worldstory-font anchor '+JSON.stringify({anchorBefore,anchorAfter}));process.exitCode=1;}
            else console.log('PASS worldstory-font font change preserves current message anchor');
            await call('Runtime.evaluate',{expression:'document.querySelector(".host-settings-dialog-footer .secondary").click()'});await pause(160);
            const restored=await frameEval('getComputedStyle(document.querySelectorAll(".sr-message .sr-rich")[199]).fontSize');
            if(restored!=='16px'){console.log('FAIL worldstory-font cancel did not restore 16px');process.exitCode=1;}
            else console.log('PASS worldstory-font cancel restores original reading size');
            await call('Runtime.evaluate',{expression:'document.querySelector(".host-settings-button").click()'});await pause(80);
            await call('Runtime.evaluate',{expression:'(()=>{const e=document.querySelector(".host-reading-slider"),s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;s.call(e,"18");e.dispatchEvent(new Event("input",{bubbles:true}))})()'});await pause(100);
            await call('Runtime.evaluate',{expression:'document.querySelector(".host-settings-dialog-footer .primary").click()'});await pause(180);
            const saved=await call('Runtime.evaluate',{expression:'localStorage.getItem("sr:session:test:reading-font-size")',returnByValue:true});
            const applied=await frameEval('getComputedStyle(document.querySelectorAll(".sr-message .sr-rich")[199]).fontSize');
            if(saved.result.value!=='18'||applied!=='18px'){console.log('FAIL worldstory-font saved preference did not persist');process.exitCode=1;}
            else console.log('PASS worldstory-font saved reading size persists per session');
            await frameEval('(()=>{const c=document.querySelector(".sr-chat-messages");c.scrollTop=c.scrollHeight;return c.scrollHeight-c.scrollTop-c.clientHeight})()');await pause(120);
            await call('Runtime.evaluate',{expression:'document.querySelector(".host-settings-button").click()'});await pause(80);
            await call('Runtime.evaluate',{expression:'(()=>{const e=document.querySelector(".host-reading-slider"),s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;s.call(e,"20");e.dispatchEvent(new Event("input",{bubbles:true}))})()'});await pause(180);
            const bottomGap=Number(await frameEval('(()=>{const c=document.querySelector(".sr-chat-messages");return c.scrollHeight-c.scrollTop-c.clientHeight})()'));
            await call('Runtime.evaluate',{expression:'document.querySelector(".host-settings-dialog-footer .secondary").click()'});await pause(120);
            if(bottomGap>2){console.log('FAIL worldstory-font font change lost the bottom anchor: '+bottomGap);process.exitCode=1;}
            else console.log('PASS worldstory-font font change preserves bottom anchoring');
          }
        }
      }
      if(name==='composer'){
        for(const width of [768,375,320]){
          await call('Emulation.setDeviceMetricsOverride',{width,height:812,deviceScaleFactor:1,mobile:width<600});
          const layout=await call('Runtime.evaluate',{returnByValue:true,expression:'JSON.stringify({viewport:document.documentElement.clientWidth,innerWidth,visualViewport:visualViewport?.width,screen:screen.width,documentWidth:document.documentElement.scrollWidth,toolbar:!!document.querySelector(".sr-composer-toolbar"),editor:!!document.querySelector(".sr-composer-editor")})'});
          const metrics=JSON.parse(layout.result.value);
          if(metrics.documentWidth>metrics.viewport+1||!metrics.toolbar||!metrics.editor){
            console.log(`FAIL composer: ${width}px responsive layout ${JSON.stringify(metrics)}`);process.exitCode=1;
          }else console.log(`PASS composer: ${width}px responsive layout`);
        }
        await call('Runtime.evaluate',{expression:'document.documentElement.dataset.theme="light"'});
        const light=await call('Runtime.evaluate',{returnByValue:true,expression:'JSON.stringify((()=>{const el=document.querySelector(".sr-composer-editor");return {background:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color}})())'});
        await call('Runtime.evaluate',{expression:'document.documentElement.dataset.theme="dark"'});
        const dark=await call('Runtime.evaluate',{returnByValue:true,expression:'JSON.stringify((()=>{const el=document.querySelector(".sr-composer-editor");return {background:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color}})())'});
        const contrast=({background,color})=>{const rgb=value=>value.match(/[0-9.]+/g).slice(0,3).map(Number).map(channel=>{const x=channel/255;return x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4;});const [r,g,b]=rgb(color),[br,bg,bb]=rgb(background);const a=.2126*r+.7152*g+.0722*b,z=.2126*br+.7152*bg+.0722*bb;return (Math.max(a,z)+.05)/(Math.min(a,z)+.05);};
        const lightStyle=JSON.parse(light.result.value),darkStyle=JSON.parse(dark.result.value);
        if(contrast(lightStyle)<4.5||contrast(darkStyle)<4.5){console.log(`FAIL composer: theme contrast light=${contrast(lightStyle).toFixed(2)} dark=${contrast(darkStyle).toFixed(2)}`);process.exitCode=1;}
        else console.log(`PASS composer: light/dark editor contrast (${contrast(lightStyle).toFixed(2)} / ${contrast(darkStyle).toFixed(2)})`);
      }
    } finally {ws.close();await fetch(`http://${debugging}/json/close/${page.id}`);}
  }
} finally {browser.kill();server.kill();await pause(300);await rm(profile,{recursive:true,force:true});}
