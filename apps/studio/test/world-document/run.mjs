// Real-browser regression for the document sanitizer. Requires local Chrome or CHROME_PATH.
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const webDir=fileURLToPath(new URL('../..',import.meta.url));
const chrome=process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const timeoutMs=Number(process.env.SR_BROWSER_TIMEOUT_MS ?? 45000);
const profile=await mkdtemp(join(tmpdir(),'sr-document-test-'));
const server=spawn(join(webDir,'node_modules/.bin/vite'),['--config','test/world-document/vite.config.mjs','--host','127.0.0.1','--port','5189','--strictPort'],{cwd:webDir,stdio:'ignore'});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try {
  let ready=false;
  for(let i=0;i<60;i++){try{if((await fetch('http://127.0.0.1:5189/test/world-document/',{signal:AbortSignal.timeout(1000)})).ok){ready=true;break}}catch{}await pause(100);}
  if(!ready)throw new Error('Vite failed to start on port 5189');
  for (const url of ['http://127.0.0.1:5189/test/world-document/', ...['world-document.html','message-portal.html','document-theme.html','world-story-roleplay.html'].map(file=>`http://127.0.0.1:5189/@fs${fileURLToPath(new URL(`../../../../packages/sr-sdk/test/${file}`, import.meta.url))}`)]) {
  console.log(`RUN ${url}`);
  const result=await new Promise((resolve,reject)=>{
    const browser=spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-sync','--metrics-recording-only',`--user-data-dir=${profile}`,'--virtual-time-budget=10000','--dump-dom',url],{stdio:['ignore','pipe','ignore']});
    let output='';const timer=setTimeout(()=>{browser.kill('SIGKILL');reject(new Error(`Chrome test timed out after ${timeoutMs}ms: ${url}`));},timeoutMs);
    browser.stdout.on('data',data=>{output+=data});browser.on('error',error=>{clearTimeout(timer);reject(error)});browser.on('exit',code=>{clearTimeout(timer);browser.stdout.destroy();code===0?resolve(output):reject(new Error(`Chrome exited ${code}`))});
  });
  const match=String(result).match(/<pre id="results?">(.*?)<\/pre>/s);
  if(!match)throw new Error('Browser did not return test results');
  const tests=JSON.parse(match[1].replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>'));
  for(const test of tests)console.log(`${test.pass?'PASS':'FAIL'} ${test.name}${test.error?`: ${test.error}`:''}`);
  if(!tests.length || tests.some(test=>!test.pass))process.exitCode=1;
  }
} finally {server.kill();await rm(profile,{recursive:true,force:true});}
