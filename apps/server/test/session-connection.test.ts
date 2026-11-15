import { expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import { createServer as createVite } from '../../studio/node_modules/vite/dist/node/index.js';
import { createApp } from '../src/app.js';
import { fakeCredentials } from './fixtures/db-seed.js';
import { runtimeFixture, textGateway, tail } from './fixtures/runtime-v2.js';

it('opens SSE through Vite immediately and closes all streams on shutdown',async()=>{
  const gateway=textGateway('story'+tail());
  const {db}=runtimeFixture(gateway);
  const app=createApp(db,fakeCredentials,gateway);
  const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const port=(server.address() as {port:number}).port;
  const proxy=await createVite({configFile:false,appType:'custom',logLevel:'silent',
    server:{host:'127.0.0.1',port:0,proxy:{'/api':`http://127.0.0.1:${port}`}},
    optimizeDeps:{noDiscovery:true,include:[]}});
  const abort=new AbortController();
  try{
    await proxy.listen();
    const origin=`http://127.0.0.1:${(proxy.httpServer!.address() as {port:number}).port}`;
    // Old behavior blocks here until the 15s heartbeat. Bound the actual HTTP request.
    const response=await fetch(origin+'/api/v1/sessions/session/events',{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(2000)])});
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader=response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(': connected\n\n');
    const closed=new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    await app.shutdown();
    expect((await reader.read()).done).toBe(true);
    await closed;
    expect((await app.request('/api/v1/sessions/session')).status).toBe(503);
    await app.shutdown(); // repeat shutdown is safe
  }finally{
    abort.abort();await app.shutdown();await proxy.close();if('closeAllConnections' in server)server.closeAllConnections();server.close();db.close();
  }
},10000);

it('shutdown stops an uncooperative model and commits the provisional story',async()=>{
  let entered!:()=>void,release!:()=>void;
  const ready=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
  const gateway=textGateway('unused');
  gateway.stream=()=>({async *[Symbol.asyncIterator](){
    yield {type:'text_delta',delta:'saved partial story',contentIndex:0,partial:{} as never};
    entered();await gate;
  }});
  const {db,runtime}=runtimeFixture(gateway);
  try{
    const accepted=await runtime.start('session','keep input','shutdown-test','opening');
    await ready;await runtime.shutdown();
    expect(runtime.busy('session')).toBe(false);
    expect(runtime.status('session',accepted.runId)).toMatchObject({status:'stopped',messages:expect.arrayContaining([
      expect.objectContaining({role:'assistant',text:'saved partial story'}),
    ])});
    await expect(runtime.prepare('session','reject after shutdown','next','opening')).rejects.toMatchObject({code:'RUN_STOPPED'});
  }finally{release();await runtime.shutdown();db.close();}
});

it('shutdown settles accepted preparation while credentials are still pending',async()=>{
  let entered!:()=>void,release!:()=>void;
  const ready=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
  const {db,runtime}=runtimeFixture(textGateway('unused'),'direct',{
    ...fakeCredentials,get:async()=>{entered();await gate;return 'fake';},
  });
  try{
    const accepted=await runtime.start('session','keep pending input','shutdown-preparation','opening');
    await ready;await runtime.shutdown();
    expect(runtime.status('session',accepted.runId)).toMatchObject({status:'stopped',messages:[],input:{text:'keep pending input'}});
    expect(runtime.busy('session')).toBe(false);
  }finally{release();await runtime.shutdown();db.close();}
});
