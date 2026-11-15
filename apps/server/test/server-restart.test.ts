import { expect,it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp,rm,access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/infrastructure/database/database.js';
import { seedSession } from './fixtures/db-seed.js';

const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
it('tsx Return restart with an open session releases the database lock every time',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sr-restart-'));
  const db=openDatabase(join(directory,'sillyrealms.sqlite'));
  seedSession(db,'session','world',null,'p',null,null,'{}',1,1);db.close();
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port=(probe.address() as {port:number}).port;
  await new Promise<void>(resolve=>probe.close(()=>resolve()));
  const stageProbe=createServer();stageProbe.listen(0,'127.0.0.1');await once(stageProbe,'listening');
  const stagePort=(stageProbe.address() as {port:number}).port;
  await new Promise<void>(resolve=>stageProbe.close(()=>resolve()));
  const child=spawn(process.execPath,[fileURLToPath(import.meta.resolve('tsx/cli')),'watch','--clear-screen=false','src/server.ts'],{
    cwd:fileURLToPath(new URL('..',import.meta.url)),
    env:{...process.env,PORT:String(port),SILLYREALMS_STAGE_PORT:String(stagePort),SILLYREALMS_DATA_DIR:directory,SILLYREALMS_DEBUG:'0'},
    stdio:['pipe','pipe','pipe'],
  });
  const exited=once(child,'exit');let logs='';
  child.stdout.on('data',chunk=>logs+=String(chunk));child.stderr.on('data',chunk=>logs+=String(chunk));
  const started=()=>logs.split('SillyRealms 本机访问:').length-1;
  const waitForStarts=async(count:number)=>{
    for(let i=0;i<120&&started()<count&&child.exitCode===null;i++)await delay(50);
    expect(logs).not.toMatch(/ELOCKED|Force killing|SR_SHUTDOWN_/);
    expect(started(),logs).toBe(count);
  };
  const abort=new AbortController();
  try{
    await waitForStarts(1);
    for(let turn=0;turn<3;turn++){
      const events=await fetch(`http://127.0.0.1:${port}/api/v1/sessions/session/events`,{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(6000)])});
      const reader=events.body!.getReader();await reader.read();
      const start=Date.now();child.stdin.write('\n');await waitForStarts(turn+2);
      expect(Date.now()-start).toBeLessThan(4500);
      expect((await reader.read()).done).toBe(true);
      expect(await (await fetch(`http://127.0.0.1:${port}/health`)).json()).toMatchObject({success:true});
      expect((await fetch(`http://127.0.0.1:${stagePort}/api/v1/worlds`)).status).toBe(404);
    }
    child.kill('SIGTERM');await exited;
    await expect(access(directory+'.lock')).rejects.toMatchObject({code:'ENOENT'});
    const released=createServer();released.listen(stagePort,'127.0.0.1');await once(released,'listening');await new Promise<void>(resolve=>released.close(()=>resolve()));
  }finally{
    abort.abort();
    if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await exited;}
    await rm(directory,{recursive:true,force:true});
  }
},25000);

it('a failed second listener releases the Stage port and database lock without announcing readiness',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sr-stage-startup-'));
  const occupied=createServer();occupied.listen(0,'0.0.0.0');await once(occupied,'listening');
  const port=(occupied.address() as {port:number}).port;
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const stagePort=(probe.address() as {port:number}).port;
  await new Promise<void>(resolve=>probe.close(()=>resolve()));
  const child=spawn(process.execPath,[fileURLToPath(import.meta.resolve('tsx/cli')),'src/server.ts'],{
    cwd:fileURLToPath(new URL('..',import.meta.url)),
    env:{...process.env,PORT:String(port),SILLYREALMS_STAGE_PORT:String(stagePort),SILLYREALMS_DATA_DIR:directory,SILLYREALMS_DEBUG:'0'},
    stdio:['ignore','pipe','pipe'],
  });
  const exited=once(child,'exit');let logs='';
  child.stdout.on('data',chunk=>logs+=String(chunk));child.stderr.on('data',chunk=>logs+=String(chunk));
  try {
    const [code]=await exited;expect(code).not.toBe(0);
    expect(logs).toContain('EADDRINUSE');expect(logs).not.toContain('SillyRealms 本机访问:');
    await expect(access(directory+'.lock')).rejects.toMatchObject({code:'ENOENT'});
    const released=createServer();released.listen(stagePort,'127.0.0.1');await once(released,'listening');await new Promise<void>(resolve=>released.close(()=>resolve()));
  }finally{
    if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await exited;}
    await new Promise<void>(resolve=>occupied.close(()=>resolve()));await rm(directory,{recursive:true,force:true});
  }
},15000);
