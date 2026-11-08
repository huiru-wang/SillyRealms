import { expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

it('starts with a temporary database and rejects a second server on the same data directory', async () => {
  const dir=mkdtempSync(join(tmpdir(),'sillyrealms-test-'));
  const listener=createServer();
  await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=(listener.address() as {port:number}).port;
  await new Promise<void>(resolve=>listener.close(()=>resolve()));
  const env={...process.env,SILLYREALMS_DATA_DIR:dir,PORT:String(port)};
  const first=spawn(process.execPath,['--import','tsx','src/server.ts'],{cwd:process.cwd(),env,stdio:'ignore'});
  try {
    let ready=false;
    for (let i=0;i<80;i++) {
      try { const response=await fetch(`http://127.0.0.1:${port}/health`); if(response.ok) {ready=true;break;} } catch { /* startup */ }
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    expect(ready).toBe(true);
    const second=spawn(process.execPath,['--import','tsx','src/server.ts'],{cwd:process.cwd(),env:{...env,PORT:String(port+1)},stdio:'ignore'});
    const exit=await Promise.race([new Promise<number|null>(resolve=>second.once('exit',resolve)),new Promise<never>((_,reject)=>setTimeout(()=>{second.kill('SIGKILL');reject(new Error('second server did not exit'));},5000))]);
    expect(exit).not.toBe(0);
  } finally {
    const stopped=new Promise<void>(resolve=>first.once('exit',()=>resolve())); first.kill('SIGTERM');
    await Promise.race([stopped,new Promise<void>(resolve=>setTimeout(()=>{first.kill('SIGKILL');resolve();},2000))]);
    rmSync(dir,{recursive:true,force:true});
  }
},10000);

it('creates the default database in the project db directory regardless of working directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sillyrealms-default-'));
  const serverDir = join(dir, 'apps', 'server');
  mkdirSync(serverDir, { recursive: true });
  cpSync('src', join(serverDir, 'src'), { recursive: true });
  cpSync('package.json', join(serverDir, 'package.json'));
  symlinkSync(resolve('node_modules'), join(serverDir, 'node_modules'), 'dir');
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) };
  delete env.SILLYREALMS_DATA_DIR;
  const server = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), join(serverDir, 'src/server.ts')], { cwd: dir, env, stdio: 'ignore' });
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) { ready = true; break; } } catch { /* startup */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(ready).toBe(true);
    expect(existsSync(join(dir, 'db', 'sillyrealms.sqlite'))).toBe(true);
  } finally {
    const stopped = new Promise<void>(resolve => server.once('exit', () => resolve()));
    server.kill('SIGTERM');
    await Promise.race([stopped, new Promise<void>(resolve => setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 2000))]);
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
