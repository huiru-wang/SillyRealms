import { afterEach,expect,it,vi } from 'vitest';
import { runtimeFixture,textGateway,tail,drain,testModel } from './fixtures/runtime-v2.js';
import { UsageStore } from '../src/runtime/persistence/usage-store.js';
import { RunStore } from '../src/runtime/persistence/run-store.js';
import type { ModelGateway } from '../src/runtime/model/pi-gateway.js';
import { fakeCredentials } from './fixtures/db-seed.js';

afterEach(()=>vi.restoreAllMocks());
it.each([false,true])('Direct sends one tool-free request and publishes only clean narrative (finalOnly=%s)',async finalOnly=>{
  const raw='你好😀。'+tail([{path:'score',value:1,reason:'PRIVATE_REASON'}]);
  const gateway=textGateway(raw,{finalOnly,chunks:raw.split('')});const original=gateway.stream;const calls:any[]=[];
  gateway.stream=(model,context,options)=>{calls.push({context,options});return original(model,context,options);};
  const {db,runtime}=runtimeFixture(gateway);
  try {
    const events:any[]=[];runtime.onEvent((_id,event,payload)=>events.push({event,payload}));
    const run=await runtime.prepare('session','go','request','opening');
    expect(await drain(run.stream)).toBe('你好😀。');
    const result=runtime.status('session',run.runId);
    expect(calls).toHaveLength(1);expect(calls[0].context).not.toHaveProperty('tools');expect(calls[0].options.toolChoice).toBeUndefined();
    expect(result).toMatchObject({status:'completed',executionMode:'direct',phase:'finalized',extensions:{stateUpdate:{status:'applied',acceptedCount:1},actionSuggestions:{status:'ready'}}});
    expect(JSON.stringify(result)).not.toContain('PRIVATE_REASON');expect(JSON.stringify(result)).not.toContain('sr_extensions>');
    expect(events.filter(e=>e.event==='run.phase').map(e=>e.payload.phase)).toContain('extensions');
    expect(events.filter(e=>e.event==='state.changed')).toHaveLength(1);
    const tip=db.prepare('SELECT state FROM entries WHERE id=(SELECT tip_entry_id FROM sessions WHERE id=?)').get('session')!;
    expect(JSON.parse(String(tip.state))).toEqual([{key:'score',value:1}]);
    const journal=String(db.prepare('SELECT usage_json FROM sessions WHERE id=?').get('session')!.usage_json);
    expect(journal).not.toContain('PRIVATE_REASON');expect(runtime.busy('session')).toBe(false);
  }finally{db.close();}
});
it.each([
  {raw:'story',status:'failed',state:'failed',suggestions:'blocked',score:0},
  {raw:'story'+tail([{path:'score',value:2},{path:'score',value:-1}]),status:'completed',state:'partial',suggestions:'blocked',score:2},
  {raw:'story'+tail([{path:'score',value:2}],['']),status:'completed',state:'applied',suggestions:'failed',score:2},
  {raw:'story<sr_extensions><state_update>[]</state_update>',status:'failed',state:'failed',suggestions:'blocked',score:0},
])('enforces the extension failure matrix: $state/$suggestions',async test=>{
  const {db,runtime}=runtimeFixture(textGateway(test.raw));
  try{
    const run=await runtime.prepare('session','go','request','opening');expect(await drain(run.stream)).toBe('story');
    expect(runtime.status('session',run.runId)).toMatchObject({status:test.status,extensions:{stateUpdate:{status:test.state},actionSuggestions:{status:test.suggestions}}});
    const row=db.prepare('SELECT state FROM entries WHERE state IS NOT NULL ORDER BY seq DESC LIMIT 1').get()!;
    expect(JSON.parse(String(row.state))).toEqual([{key:'score',value:test.score}]);
  }finally{db.close();}
});
it('does not commit on length termination or cancellation after the hidden tail begins',async()=>{
  for(const cancelled of [false,true]){
    const {db,runtime}=runtimeFixture(textGateway('story'+tail([{path:'score',value:9}]),{reason:cancelled?'stop':'length'}));
    try{
      if(cancelled)runtime.onEvent((id,event,payload)=>{if(event==='run.phase'&&payload.phase==='extensions')void runtime.stop(id,String(payload.runId));});
      const run=await runtime.prepare('session','go','request','opening');await drain(run.stream);
      expect(runtime.status('session',run.runId)?.status).toBe(cancelled?'stopped':'failed');
      const row=db.prepare('SELECT state FROM entries WHERE state IS NOT NULL ORDER BY seq DESC LIMIT 1').get()!;
      expect(JSON.parse(String(row.state))).toEqual([{key:'score',value:0}]);
      expect(runtime.busy('session')).toBe(false);
    }finally{db.close();}
  }
});
it('isolates usage attachment failure and notification exceptions from committed story/state',async()=>{
  const settle=vi.spyOn(UsageStore.prototype,'settleRun');
  vi.spyOn(UsageStore.prototype,'attachEntry').mockImplementation(()=>{throw Error('usage fixture');});
  vi.spyOn(UsageStore.prototype,'attachCompaction').mockImplementation(()=>{throw Error('usage fixture');});
  const {db,runtime}=runtimeFixture(textGateway('story'+tail([{path:'score',value:2}])));
  try{
    runtime.onEvent(()=>{throw Error('listener fixture');});
    const run=await runtime.prepare('session','go','request','opening');await drain(run.stream);
    expect(runtime.status('session',run.runId)?.status).toBe('completed');expect(settle).toHaveBeenCalledTimes(1);
    expect(runtime.busy('session')).toBe(false);
  }finally{db.close();}
});
it('cancels preparing even when credential storage never resolves',async()=>{
  const credentials={...fakeCredentials,get:()=>new Promise<string|null>(()=>{})};
  const {db,runtime}=runtimeFixture(textGateway('unused'), 'direct', credentials);
  try{
    const started=await runtime.start('session','go','request','opening');
    expect(runtime.activeRun('session')).toMatchObject({id:started.runId,status:'preparing',executionMode:'direct'});
    const result=await runtime.stop('session',started.runId);
    expect(result?.status).toBe('stopped');expect(runtime.busy('session')).toBe(false);
    expect(db.prepare("SELECT count(*) AS count FROM entries WHERE role='user'").get()!.count).toBe(0);
  }finally{db.close();}
});
it('rolls back state and result atomically when the final state write fails',async()=>{
  const {db,runtime}=runtimeFixture(textGateway('story'+tail([{path:'score',value:4}])));
  try {
    db.exec("CREATE TRIGGER fail_state BEFORE UPDATE OF state ON entries BEGIN SELECT RAISE(ABORT,'fixture'); END;");
    const run=await runtime.prepare('session','go','request','opening');await drain(run.stream);
    expect(runtime.status('session',run.runId)).toMatchObject({status:'failed',extensions:{stateUpdate:{status:'failed'}}});
    expect(db.prepare("SELECT count(*) AS count FROM entries WHERE state IS NOT NULL AND id!='opening'").get()!.count).toBe(0);
    expect(runtime.busy('session')).toBe(false);
  }finally{db.close();}
});
it('rejects unsupported adapters and unknown measurement before a generation request',async()=>{
  for(const unsupported of [false,true]){
    let calls=0;
    const gateway:ModelGateway={resolve:()=>testModel,toolVerified:()=>true,supportsDirect:()=>!unsupported,
      measure:async()=>({tokens:null,quality:'unknown',method:'unsupported',version:'1'}),
      stream:()=>{calls++;throw Error('must not run');}};
    const {db,runtime}=runtimeFixture(gateway);
    try {
      await expect(runtime.prepare('session','go','request','opening')).rejects.toMatchObject({code:unsupported?'NARRATIVE_SYSTEM_ORDER_UNSUPPORTED':'CONTEXT_MEASUREMENT_UNSUPPORTED'});
      expect(calls).toBe(0);expect(runtime.busy('session')).toBe(false);
    }finally{db.close();}
  }
});
it('keeps configuration frozen across asynchronous measurement and permits idempotent finalization only once',async()=>{
  let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  const gateway=textGateway('story'+tail());const measure=gateway.measure!;
  gateway.measure=async(m,c,o)=>{entered();await gate;return measure(m,c,o);};
  const {db,runtime,preset}=runtimeFixture(gateway);
  try {
    const preparing=runtime.prepare('session','go','request','opening');await ready;
    preset.capabilities.state_update.enabled=false;
    db.prepare('UPDATE presets SET config_json=?').run(JSON.stringify(preset));
    release();const run=await preparing;await drain(run.stream);
    expect(runtime.status('session',run.runId)).toMatchObject({capabilities:{stateUpdate:{enabled:true}},extensions:{stateUpdate:{status:'unchanged'}}});
    const user=db.prepare("SELECT id FROM entries WHERE run_id=? AND role='user'").get(run.runId)!;
    expect(new RunStore(db).finalize('session',String(user.id),null,'failed',{score:999},null)).toBe(false);
    expect(runtime.status('session',run.runId)?.status).toBe('completed');
  }finally{db.close();}
});
