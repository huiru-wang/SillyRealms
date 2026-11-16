import {expect,it} from 'vitest';
import {compactRunMetadata} from '../src/infrastructure/database/compact-run-metadata.js';
import {runtimeFixture,textGateway,tail,drain} from './fixtures/runtime-v2.js';
import {sessionRuntimeRoutes} from '../src/routes/session-runtime.js';
import {RunStore} from '../src/runtime/persistence/run-store.js';
const extensions={stateUpdate:{status:'applied'},actionSuggestions:{status:'ready'}};
it('stores only compact outcomes and returns the same minimal contract over HTTP and SSE',async()=>{
 const {db,runtime}=runtimeFixture(textGateway('story'+tail([{path:'score',value:1,reason:'PRIVATE_REASON'}])));
 const routes=sessionRuntimeRoutes(db,runtime),reader=(await routes.request('/session/events')).body!.getReader();
 try{
  const run=await runtime.prepare('session','go','request','opening');await drain(run.stream);
  let events='';while(!events.includes('event: run.completed'))events+=new TextDecoder().decode((await reader.read()).value);
  const event=JSON.parse(/event: run.completed\ndata: ([^\n]+)/.exec(events)![1]!);
  const rows=db.prepare("SELECT role,ext_data FROM entries WHERE run_id=? ORDER BY seq").all(run.runId);
  expect(JSON.parse(String(rows[0]!.ext_data))).toEqual({requestId:'request',run:{status:'completed',extensions}});
  expect(JSON.parse(String(rows[1]!.ext_data))).toEqual({});
  const detail=(await (await routes.request('/session/runs/'+run.runId)).json() as any).data;
  expect(Object.keys(detail).sort()).toEqual(['extensions','messages','phase','runId','status','tipEntryId']);
  const history=(await (await routes.request('/session/runs')).json() as any).data.runs.at(-1);
  expect(Object.keys(history).sort()).toEqual(['extensions','id','messages','phase','status']);
  for(const value of [detail,history,event])expect(value.extensions).toEqual(extensions);
  for(const key of ['capabilities','failure','recovery','runtime','protocol','acceptedCount','warningCodes','PRIVATE_REASON'])expect(JSON.stringify({detail,history,event,rows})).not.toContain(key);
  expect(new RunStore(db).duplicate('session','request')).toBe(run.runId);
  const user=db.prepare("SELECT id FROM entries WHERE run_id=? AND role='user'").get(run.runId)!;
  expect(new RunStore(db).finalize('session',String(user.id),'failed',{score:99})).toBe(false);
 }finally{await reader.cancel();db.close();}
});
it('compacts stored metadata without changing messages, state, usage, links or edit times; reruns are no-ops',async()=>{
 const {db,runtime}=runtimeFixture(textGateway('story'+tail([{path:'score',value:1}])));
 try{
  const run=await runtime.prepare('session','go','request','opening');await drain(run.stream);
  const old={requestId:'request',run:{runId:run.runId,status:'completed',phase:'finalized',capabilities:{presetHash:'old'},extensions:{protocol:'sr-output-blocks/v1',stateUpdate:{status:'applied',acceptedCount:1,changedPaths:['score'],skipped:[],warningCodes:[]},actionSuggestions:{status:'ready',count:3,items:['old'],warningCodes:[]}}},runtime:{finalized:true,contextPolicy:{},diagnostics:{}}};
  db.prepare("UPDATE entries SET ext_data=? WHERE run_id=? AND role='user'").run(JSON.stringify(old),run.runId);
  db.prepare("UPDATE entries SET ext_data=? WHERE run_id=? AND role='assistant'").run(JSON.stringify({origin:'pi',status:'completed'}),run.runId);
  db.prepare("UPDATE entries SET ext_data=? WHERE id='opening'").run(JSON.stringify({origin:'opening',run:{status:'completed'}}));
  db.prepare("INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,timestamp,payload,ext_data) VALUES('summary','session','opening',?,100,'compaction',1,?,?)").run(run.runId,JSON.stringify({summary:'summary text'}),JSON.stringify({summary:{kind:'sillyrealms.summary',coveredThroughEntryId:'opening'},runtime:{unused:true}}));
  db.prepare("INSERT INTO run_preparations(run_id,session_id,request_id,expected_tip_entry_id,input_text,status,created_at,result_json) VALUES('prep','session','prep-request','opening','saved','failed',1,?)").run(JSON.stringify({runId:'prep',status:'failed',phase:'finalized',errorCode:'SUMMARY_FAILED',errorMessage:'old',recovery:{inputSaved:true},failure:{stage:'preparation'}}));
  const snapshot=()=>db.prepare('SELECT * FROM entries ORDER BY seq').all().map(({ext_data:_ext,...row})=>row),before=snapshot();
  const sessions=db.prepare('SELECT * FROM sessions').all();
  expect(compactRunMetadata(db)).toMatchObject({entries:4,preparations:1});expect(snapshot()).toEqual(before);expect(db.prepare('SELECT * FROM sessions').all()).toEqual(sessions);
  expect(JSON.parse(String(db.prepare("SELECT ext_data FROM entries WHERE id='summary'").get()!.ext_data))).toEqual({summary:{coveredThroughEntryId:'opening'}});
  expect(JSON.parse(String(db.prepare("SELECT result_json FROM run_preparations").get()!.result_json))).toEqual({errorCode:'SUMMARY_FAILED'});
  expect(runtime.status('session','prep')).toMatchObject({status:'failed',errorCode:'SUMMARY_FAILED',input:{text:'saved'}});
  expect(new RunStore(db).duplicate('session','request')).toBe(run.runId);
  expect(compactRunMetadata(db)).toEqual({entries:0,preparations:0,bytesRemoved:0});
 }finally{db.close();}
});
it('rolls metadata cleanup back if a summary boundary is invalid',()=>{
 const {db}=runtimeFixture(textGateway('unused'));
 try{
  db.prepare("UPDATE entries SET ext_data=? WHERE id='opening'").run(JSON.stringify({origin:'opening',unused:true}));
  db.prepare("INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,timestamp,payload,ext_data) VALUES('bad','session','opening','bad-run',2,'compaction',1,'{}','{}')").run();
  const before=db.prepare('SELECT * FROM entries').all();expect(()=>compactRunMetadata(db)).toThrow('Invalid summary boundary');expect(db.prepare('SELECT * FROM entries').all()).toEqual(before);
 }finally{db.close();}
});
