import {expect,it} from 'vitest';
import {createApp} from '../src/app.js';
import {runtimeFixture,textGateway,tail} from './fixtures/runtime-v2.js';
import {fakeCredentials} from './fixtures/db-seed.js';
import {sessionRoutes} from '../src/routes/sessions.js';
const patch=(body:unknown)=>({method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
it('reads capabilities from preset nodes and rejects session overrides and execution modes',async()=>{
 const gateway=textGateway('story'+tail()),{db}=runtimeFixture(gateway),app=createApp(db,fakeCredentials,gateway);
 try{
  const response=await app.request('/api/v1/sessions/session/capabilities');expect((await response.json() as any).data).toMatchObject({effective:{state_update:{enabled:true},action_suggestions:{enabled:true}}});
  expect((await app.request('/api/v1/sessions/session/capabilities',patch({overrides:{state_update:false}}))).status).toBe(404);
  expect((await app.request('/api/v1/sessions/session',patch({executionMode:'agent'}))).status).toBe(422);
 }finally{db.close();}
});
it('rechecks busy state after asynchronous credential validation before session changes',async()=>{
 const {db}=runtimeFixture(textGateway(''));let busy=false,release!:()=>void,entered!:()=>void;
 const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 const routes=sessionRoutes(db,()=>busy,undefined,undefined,undefined,{...fakeCredentials,get:async()=>{entered();await gate;return 'fake';}});
 try{const pending=routes.request('/session',patch({title:'changed'}));await ready;busy=true;release();expect((await pending).status).toBe(409);expect(db.prepare('SELECT title FROM sessions').get()!.title).toBeNull();}finally{db.close();}
});
