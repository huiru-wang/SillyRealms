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
  for(const name of ['composer','host-roleplay']){
    const page=await (await fetch(`http://${debugging}/json/new?http://127.0.0.1:${port}/test/${name}/`,{method:'PUT'})).json();
    const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
    let sequence=0;const call=(method,params={})=>new Promise((resolve,reject)=>{
      const id=++sequence;const onMessage=event=>{const response=JSON.parse(event.data);if(response.id!==id)return;ws.removeEventListener('message',onMessage);response.error?reject(Error(response.error.message)):resolve(response.result);};
      ws.addEventListener('message',onMessage);ws.send(JSON.stringify({id,method,params}));
    });
    try {
      let tests=[];for(let i=0;i<150;i++){
        const result=await call('Runtime.evaluate',{expression:'document.querySelector("#results")?.textContent || "[]"',returnByValue:true});
        tests=JSON.parse(result.result.value);if(tests.length)break;await pause(100);
      }
      if(!tests.length)throw new Error(`${name}: no browser test results`);
      for(const test of tests)console.log(`${test.pass?'PASS':'FAIL'} ${name}: ${test.name}${test.error?`: ${test.error}`:''}`);
      if(tests.some(test=>!test.pass))process.exitCode=1;
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
