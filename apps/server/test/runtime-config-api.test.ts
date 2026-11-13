import { expect,it } from 'vitest';
import { createApp } from '../src/app.js';
import { runtimeFixture,textGateway,tail } from './fixtures/runtime-v2.js';
import { fakeCredentials } from './fixtures/db-seed.js';
import { sessionRoutes } from '../src/routes/sessions.js';
const patch=(value:unknown)=>({method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
it('merges capability overrides with revision conflicts, inheritance reset and strict public fields',async()=>{
  const gateway=textGateway('story'+tail()),{db}=runtimeFixture(gateway),app=createApp(db,fakeCredentials,gateway);
  try {
    const get=async()=>await (await app.request('/api/v1/sessions/session/capabilities')).json() as any;
    expect((await get()).data).toMatchObject({revision:0,overrides:{},availability:{applicable:true}});
    const change=await app.request('/api/v1/sessions/session/capabilities',patch({expectedRevision:0,overrides:{state_update:false}}));
    expect(change.status).toBe(200);expect((await change.json() as any).data).toMatchObject({revision:1,effective:{state_update:{enabled:false},action_suggestions:{enabled:true}},sources:{state_update:'session'}});
    expect((await app.request('/api/v1/sessions/session/capabilities',patch({expectedRevision:0,overrides:{action_suggestions:false}}))).status).toBe(409);
    expect((await app.request('/api/v1/sessions/session/capabilities',patch({expectedRevision:1,overrides:{state_update:null}}))).status).toBe(200);
    expect((await get()).data).toMatchObject({revision:2,overrides:{},effective:{state_update:{enabled:true}},sources:{state_update:'preset'}});
    expect((await app.request('/api/v1/sessions/session/capabilities',patch({expectedRevision:2,overrides:{state_update:{prompt:'PRIVATE'}}}))).status).toBe(422);
    expect((await app.request('/api/v1/sessions/session',patch({executionMode:'agent'}))).status).toBe(200);
    expect((await get()).data.availability).toEqual({applicable:false,reason:'agent_mode'});
    expect(JSON.stringify((await get()).data)).not.toContain('prompt');
  }finally{db.close();}
});
it('deep-merges preset capabilities, preserving unrelated fields and rejecting null/unknown fields',async()=>{
  const gateway=textGateway(''),{db}=runtimeFixture(gateway),app=createApp(db,fakeCredentials,gateway);
  try{
    const path='/api/v1/presets/sr-default-preset';
    expect((await app.request(path,patch({capabilities:{action_suggestions:{count:4,prompt:'keep'}}}))).status).toBe(200);
    expect((await app.request(path,patch({capabilities:{action_suggestions:{enabled:false}}}))).status).toBe(200);
    const read=await (await app.request(path)).json() as any;
    expect(read.data.item.capabilities.action_suggestions).toEqual({enabled:false,count:4,prompt:'keep'});
    expect(read.data.item.capabilities.state_update.enabled).toBe(true);
    for(const capabilities of [null,{state_update:{enabled:'true'}},{action_suggestions:{count:5}},{unknown:{enabled:true}}]){
      expect((await app.request(path,patch({capabilities}))).status).toBe(422);
    }
    const exported=await (await app.request(path+'/export')).json() as any;
    expect(JSON.stringify(exported)).toContain('"count":4');
  }finally{db.close();}
});
it('rechecks busy after awaited credential validation before changing mode',async()=>{
  const {db}=runtimeFixture(textGateway(''));let busy=false,release!:()=>void,entered!:()=>void;
  const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  const routes=sessionRoutes(db,()=>busy,undefined,undefined,undefined,{...fakeCredentials,get:async()=>{entered();await gate;return 'fake';}});
  try{
    const pending=routes.request('/session',patch({executionMode:'agent'}));await ready;busy=true;release();
    expect((await pending).status).toBe(409);expect(db.prepare("SELECT execution_mode FROM sessions WHERE id='session'").get()!.execution_mode).toBe('direct');
  }finally{db.close();}
});
it('exposes preparing via session GET, freezes this run, and permits next-run capability overrides while busy',async()=>{
  const gateway=textGateway('story'+tail());let release!:()=>void,entered!:()=>void;
  const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r),measure=gateway.measure!;
  gateway.measure=async(...args)=>{entered();await gate;return measure(...args);};
  const {db}=runtimeFixture(gateway),app=createApp(db,fakeCredentials,gateway);
  try {
    const res=await app.request('/api/v1/sessions/session/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'go',requestId:crypto.randomUUID(),expectedTipEntryId:'opening'})});
    expect(res.status).toBe(202);const {runId}=(await res.json() as any).data;await ready;
    const current=(await (await app.request('/api/v1/sessions/session')).json() as any).data;
    expect(current.activeRun).toMatchObject({id:runId,status:'preparing',executionMode:'direct'});
    expect((await app.request('/api/v1/sessions/session',patch({executionMode:'agent'}))).status).toBe(409);
    expect((await app.request('/api/v1/sessions/session/capabilities',patch({expectedRevision:0,overrides:{state_update:false}}))).status).toBe(200);
    release();let result:any;
    for(let i=0;i<100;i++){result=(await (await app.request('/api/v1/sessions/session/runs/'+runId)).json() as any).data;if(result.status==='completed')break;await new Promise(r=>setTimeout(r,2));}
    expect(result).toMatchObject({status:'completed',capabilities:{revision:0,stateUpdate:{enabled:true}},extensions:{stateUpdate:{status:'unchanged'}}});
    const history=(await (await app.request('/api/v1/sessions/session/runs')).json() as any).data.runs.at(-1);
    expect(history.extensions).toEqual(result.extensions);
    expect((await (await app.request('/api/v1/sessions/session')).json() as any).data.activeRun).toBeNull();
  }finally{release?.();db.close();}
});
