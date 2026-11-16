/** Development uses the same package handler through the independent Vite Stage proxy. */
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';

const root=fileURLToPath(new URL('../../../..',import.meta.url));
const temporary=await mkdtemp(join(tmpdir(),'sr-offline-proxy-'));
const manifestPath=join(temporary,'manifest.json');
const children=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const assert=(value,message)=>{if(!value)throw Error(message);};
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
function start(command,args,options){const child=spawn(command,args,{...options,stdio:['ignore','pipe','pipe']});let logs='';child.stdout.on('data',chunk=>logs+=chunk);child.stderr.on('data',chunk=>logs+=chunk);children.push(child);return ()=>logs;}
async function ready(url,logs){for(let i=0;i<160;i++){try{const response=await fetch(url);if(response.ok)return response;}catch{}await delay(100);}throw Error('Server failed: '+logs());}
try {
  const logs=start(join(root,'apps/server/node_modules/.bin/tsx'),['test/studio-browser-server.ts'],{cwd:join(root,'apps/server'),env:{...process.env,SR_TEST_MANIFEST:manifestPath}});
  let manifest;
  for(let i=0;i<150;i++){try{manifest=JSON.parse(await readFile(manifestPath,'utf8'));break;}catch{}await delay(100);}
  assert(manifest,'Isolated API did not start: '+logs());
  const stagePort=await freePort(),hostPort=await freePort();
  const env={...process.env,SR_STUDIO_SERVER_URL:'http://127.0.0.1:'+manifest.port,SILLYREALMS_STAGE_PORT:manifest.stagePort,SR_STUDIO_STAGE_PORT:String(stagePort)};
  const stageLogs=start(join(root,'apps/studio/node_modules/.bin/vite'),['--mode','stage','--port',String(stagePort)],{cwd:join(root,'apps/studio'),env});
  const hostLogs=start(join(root,'apps/studio/node_modules/.bin/vite'),['--port',String(hostPort)],{cwd:join(root,'apps/studio'),env});
  const stage='http://127.0.0.1:'+stagePort,host='http://127.0.0.1:'+hostPort;
  await ready(stage+'/frame.html',stageLogs);
  const config=await(await ready(host+'/api/v1/runtime/web-config',hostLogs)).json();
  assert(config.data.stage.port===stagePort,'Host did not advertise the independent Vite Stage');
  const path='/world-assets/'+manifest.offlineWorldId+'/assets/images/'+encodeURIComponent('港口 夜景.svg');
  const first=await fetch(stage+path);assert(first.status===200&&first.headers.get('content-type').includes('image/svg+xml'),'Vite package proxy failed');await first.arrayBuffer();
  const cached=await fetch(stage+path,{headers:{'If-None-Match':first.headers.get('etag')}});
  assert(cached.status===304,'Vite package proxy lost conditional caching');
  const audio=await fetch(stage+'/world-assets/'+manifest.offlineWorldId+'/assets/audio/sea.wav',{headers:{Range:'bytes=0-43'}});
  assert(audio.status===206&&audio.headers.get('content-type')==='audio/wav'&&(await audio.arrayBuffer()).byteLength===44,'Vite package proxy lost media headers or Range');
  const sources=await(await fetch(host+'/api/v1/worlds/'+manifest.offlineWorldId+'/components')).json();
  assert(sources.success&&sources.data.items.some(item=>item.id==='Main'),'Host component source API proxy failed');
  assert((await fetch(stage+'/api/v1/worlds')).status===404,'Development Stage exposes business APIs');
  assert((await fetch(host+'/frame.html')).status===404,'Development Host exposes author execution entry');
  console.log('PASS: development Host/Stage config, Unicode package proxy, MIME, 304, Range, source API and origin separation');
}finally{
  for(const child of children.reverse())child.kill('SIGTERM');
  await Promise.all(children.map(child=>child.exitCode!==null?Promise.resolve():new Promise(resolve=>{child.once('exit',resolve);setTimeout(resolve,3000).unref();})));
  await rm(temporary,{recursive:true,force:true});
}
