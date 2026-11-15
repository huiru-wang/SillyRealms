import {expect,it} from 'vitest';
import {Hono} from 'hono';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStageApp,stageConfig,publicOrigin,serveWebConfig} from '../src/infrastructure/http/stage-assets.js';
import {serveStudio} from '../src/infrastructure/http/studio-assets.js';
import {createApp} from '../src/app.js';
import {openDatabase} from '../src/infrastructure/database/database.js';
import {stageURL,worldComponentURL} from '../../studio/src/stage-url.js';

it('resolves stable LAN/HTTPS stage addresses and rejects unsafe configurations',()=>{
  const config={stage:stageConfig({SILLYREALMS_STAGE_PORT:'3001'})};
  expect(stageURL(config,'http://192.168.1.8:3000','first').origin).toBe('http://192.168.1.8:3001');
  expect(stageURL(config,'http://[::1]:3000','first').origin).toBe('http://[::1]:3001');
  expect(stageURL(config,'http://127.0.0.1:3000','first').searchParams.get('hostOrigin')).toBe('http://127.0.0.1:3000');
  const https={stage:{...config.stage,origin:'https://stage.example.com'}};
  expect(stageURL(https,'https://app.example.com','second').href).toContain('https://stage.example.com/frame.html?hostOrigin=');
  for(const value of ['', '0','65536','abc'])expect(()=>stageConfig({SILLYREALMS_STAGE_PORT:value})).toThrow();
  for(const value of ['null','file:///x','https://user:secret@example.com','https://example.com/path','https://example.com?x=1','https://example.com/#x'])expect(()=>publicOrigin(value)).toThrow();
  expect(()=>stageURL(config,'http://127.0.0.1:3001','n')).toThrow();
  expect(()=>stageURL({stage:{...config.stage,origin:'http://stage.example.com'}},'https://app.example.com','n')).toThrow();
  expect(()=>stageURL({},'http://localhost:3000','n')).toThrow();
  const preview=worldComponentURL(https,'https://app.example.com','preview');
  expect(preview.origin).toBe('https://stage.example.com');
  expect(preview.pathname).toBe('/world-component.html');
  expect(preview.hash).toBe('#preview');
  expect(preview.searchParams.get('hostOrigin')).toBe('https://app.example.com');
  expect(()=>worldComponentURL(config,'http://127.0.0.1:3001','n')).toThrow();
  expect(()=>worldComponentURL(config,'https://127.0.0.1:3000','n')).not.toThrow();
  expect(()=>worldComponentURL({stage:{...config.stage,origin:'http://stage.example.com'}},'https://app.example.com','n')).toThrow();
});

it('separates renderer/static assets from the platform and keeps preview isolation in response headers',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sr-stage-assets-'));
  try {
    await mkdir(join(directory,'assets'));
    for(const file of ['index.html','frame.html','world-component.html','assets/frame.js'])await writeFile(join(directory,file),file);
    const platform=new Hono();serveStudio(platform,directory);
    const stage=createStageApp(directory);
    for(const path of ['/frame.html','/%66rame.html','//frame.html','/world-component.html','/%77orld-component.html','//world-component.html','/assets/%2e%2e%2fworld-component.html'])expect((await platform.request(path)).status).toBe(404);
    expect(await (await platform.request('/sessions/test')).text()).toBe('index.html');
    expect((await stage.request('/frame.html')).headers.get('Content-Security-Policy')).toBe('sandbox allow-scripts allow-same-origin');
    const preview=await stage.request('/world-component.html');
    expect(await preview.text()).toBe('world-component.html');
    expect(preview.headers.get('Content-Security-Policy')).toBe('sandbox allow-scripts allow-same-origin');
    expect(preview.headers.get('Cache-Control')).toBe('no-cache');
    expect(await (await stage.request('/assets/frame.js')).text()).toBe('assets/frame.js');
    for(const path of ['/','/index.html','/sessions/test','/api/v1/worlds','/health','/assets/../index.html','/assets/%2e%2e%2findex.html'])expect((await stage.request(path)).status).toBe(404);
    expect((await stage.request('/frame.html',{method:'POST'})).status).toBe(404);
    expect((await stage.request('/world-component.html',{method:'POST'})).status).toBe(404);
  }finally{await rm(directory,{recursive:true,force:true});}
});

it('returns the public configuration and rejects simple Stage-origin writes before side effects',async()=>{
  const db=openDatabase(':memory:');
  const origin='http://127.0.0.1:3001',app=createApp(db,undefined,undefined,undefined,new Set(['https://app.example.com']),new Set([origin]));
  serveWebConfig(app,{origin:null,port:3001,entryPath:'/frame.html'});
  try {
    expect(await (await app.request('/api/v1/runtime/web-config')).json()).toMatchObject({success:true,data:{stage:{origin:null,port:3001}}});
    const body=JSON.stringify({type:'world',name:'stage-should-not-write'});
    const response=await app.request('/api/v1/tags',{method:'POST',headers:{Origin:origin,'Content-Type':'text/plain'},body});
    expect(response.status).toBe(403);
    expect(db.prepare('SELECT id FROM tags WHERE name=?').get('stage-should-not-write')).toBeUndefined();
    expect((await app.request('/api/v1/tags',{method:'POST',headers:{Origin:'https://app.example.com','Content-Type':'application/json'},body})).status).toBe(201);
  }finally{await app.shutdown();db.close();}
});
