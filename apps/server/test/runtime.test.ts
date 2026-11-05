import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/infrastructure/database/database.js';
import type { CredentialStore } from '../src/infrastructure/credentials/store.js';
import type { ModelGateway } from '../src/agent/gateway.js';
import type { Api, AssistantMessageEvent, Model } from '@earendil-works/pi-ai';

const model:Model<Api> = { id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://localhost',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32768,maxTokens:1024 };
class MemoryCredentials implements CredentialStore { async set(){} async get(){return 'dummy';} async delete(){} }
function setup(gateway:ModelGateway) {
  const db = openDatabase(':memory:'), now = Date.now();
  const world = { spec:'world_card',spec_version:'0.1',data:{name:'test',characters:[{id:'player',name:'player',player_selectable:true,description:'{{user}}'}],openings:[{id:'opening',name:'start',content:'opening'}]} };
  const ids = ['main','personaInfo','characterInfo','worldState','chatHistory','userInput','postHistory'];
  const preset = {name:'test',api_model_config_id:'model-config',budget:{max_output_tokens:64},summary_prompt:'summary',nodes:ids.map(id=>({id,kind:'system',role:id==='chatHistory'?'auto':id==='userInput'?'user':'system',enabled:true,content:id==='main'?'hello':''}))};
  db.prepare('INSERT INTO worlds VALUES(?,?,?,?,?,?)').run('world','test',JSON.stringify(world),'{}',now,now);
  db.prepare('INSERT INTO api_model_configs VALUES(?,?,?,?,?,?,?)').run('model-config','test','fake','fake','secret-ref',now,now);
  db.prepare('INSERT INTO presets VALUES(?,?,?,?,?,?)').run('preset','test',JSON.stringify(preset),0,now,now);
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?)').run('session','world','preset','player','opening-entry',null,'{}',now,now);
  db.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('opening-entry','session',null,'opening-run',1,'message','assistant',0,now,JSON.stringify({message:{role:'assistant',content:[{type:'text',text:'opening'}]}}),'[]',JSON.stringify({run:{status:'completed'}}));
  return {db,app:createApp(db,new MemoryCredentials(),gateway)};
}

describe('stream persistence', () => {
  it('retains the output received before stop and marks the run stopped', async () => {
    const gateway:ModelGateway = {resolve:()=>model,toolVerified:()=>true,stream:(_m,_c,{signal}) => ({async *[Symbol.asyncIterator]() {
      yield {type:'text_delta',delta:'partial',contentIndex:0,partial:{} as never} as AssistantMessageEvent;
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort',()=>resolve(),{once:true}); });
      yield {type:'error',reason:'aborted',error:{} as never} as AssistantMessageEvent;
    }})};
    const {db,app} = setup(gateway);
    const response = await app.request('/api/v1/sessions/session/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:' hello ',requestId:'4bec5c7c-f8a9-4568-9768-3b888ff16a11',expectedTipEntryId:'opening-entry'})});
    expect(response.status).toBe(200);
    const runId = response.headers.get('x-run-id')!;
    const reader = response.body!.getReader(); const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('partial');
    const concurrent=await app.request('/api/v1/sessions/session/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'other',requestId:'4bec5c7c-f8a9-4568-9768-3b888ff16a10',expectedTipEntryId:'opening-entry'})});
    expect(concurrent.status).toBe(409); expect((await concurrent.json() as {error:{code:string}}).error.code).toBe('SESSION_BUSY');
    const stopped = await app.request(`/api/v1/sessions/session/runs/${runId}/stop`,{method:'POST'});
    expect(stopped.status).toBe(200);
    expect((await stopped.json() as {status:string}).status).toBe('stopped');
    const history = await (await app.request('/api/v1/sessions/session/history')).json() as {runs:Array<{entries:Array<{text:string}>}>};
    expect(history.runs.flatMap(r=>r.entries.map(e=>e.text))).toContain('partial');
    expect(history.runs.flatMap(r=>r.entries.map(e=>e.text))).toContain(' hello ');
    const retry=await app.request('/api/v1/sessions/session/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:' hello ',requestId:'4bec5c7c-f8a9-4568-9768-3b888ff16a11',expectedTipEntryId:'opening-entry'})});
    const retryBody=await retry.json() as {error:{code:string;details:{runId:string}}};
    expect(retry.status).toBe(409);expect(retryBody.error.code).toBe('REQUEST_ALREADY_EXISTS');expect(retryBody.error.details.runId).toBe(runId);
    db.close();
  });
  it('reassembles a split surrogate pair before persisting and emitting UTF-8', async () => {
    const gateway:ModelGateway={resolve:()=>model,toolVerified:()=>true,stream:()=>({async *[Symbol.asyncIterator]() {
      yield {type:'text_delta',delta:'\ud83d',contentIndex:0,partial:{} as never} as AssistantMessageEvent;
      yield {type:'text_delta',delta:'\ude00',contentIndex:0,partial:{} as never} as AssistantMessageEvent;
      yield {type:'done',reason:'stop',message:{role:'assistant',content:[{type:'text',text:'😀'}],api:'openai-completions',provider:'fake',model:'fake',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:0}} as AssistantMessageEvent;
    }})};
    const {db,app}=setup(gateway);
    const response=await app.request('/api/v1/sessions/session/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'go',requestId:'4bec5c7c-f8a9-4568-9768-3b888ff16a17',expectedTipEntryId:'opening-entry'})});
    expect(await response.text()).toBe('😀');
    const history=await (await app.request('/api/v1/sessions/session/history')).json() as {runs:Array<{entries:Array<{text:string}>}>};
    expect(history.runs.flatMap(run=>run.entries.map(entry=>entry.text))).toContain('😀'); db.close();
  });
  it('retains emitted text but reports failure if the provider errors mid-stream', async () => {
    const gateway:ModelGateway={resolve:()=>model,toolVerified:()=>true,stream:()=>({async *[Symbol.asyncIterator]() {
      yield {type:'text_delta',delta:'already shown',contentIndex:0,partial:{} as never} as AssistantMessageEvent;
      yield {type:'error',reason:'error',error:{} as never} as AssistantMessageEvent;
    }})};
    const {db,app}=setup(gateway);
    const response=await app.request('/api/v1/sessions/session/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'go',requestId:'4bec5c7c-f8a9-4568-9768-3b888ff16a20',expectedTipEntryId:'opening-entry'})});
    expect(await response.text()).toBe('already shown');
    const status=await (await app.request(`/api/v1/sessions/session/runs/${response.headers.get('x-run-id')}`)).json() as {status:string};
    expect(status.status).toBe('failed');
    const history=await (await app.request('/api/v1/sessions/session/history')).json() as {runs:Array<{entries:Array<{text:string}>}>};
    expect(history.runs.flatMap(run=>run.entries.map(entry=>entry.text))).toContain('already shown');db.close();
  });
  it('stops even if a provider ignores abort and never produces another chunk', async () => {
    const gateway:ModelGateway = {resolve:()=>model,toolVerified:()=>true,stream:()=>({async *[Symbol.asyncIterator]() {
      yield {type:'text_delta',delta:'visible',contentIndex:0,partial:{} as never} as AssistantMessageEvent;
      await new Promise<void>(()=>{});
    }})};
    const {db,app}=setup(gateway);
    const response=await app.request('/api/v1/sessions/session/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'go',requestId:'4bec5c7c-f8a9-4568-9768-3b888ff16a14',expectedTipEntryId:'opening-entry'})});
    const reader=response.body!.getReader(); expect(new TextDecoder().decode((await reader.read()).value)).toBe('visible');
    const stopped=await Promise.race([app.request(`/api/v1/sessions/session/runs/${response.headers.get('x-run-id')}/stop`,{method:'POST'}),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('stop timed out')),1000))]);
    expect((await stopped.json() as {status:string}).status).toBe('stopped');
    db.close();
  });
  it('stops an active run before deleting its world and sessions', async () => {
    const gateway:ModelGateway={resolve:()=>model,toolVerified:()=>true,stream:()=>({async *[Symbol.asyncIterator]() {
      yield {type:'text_delta',delta:'visible',contentIndex:0,partial:{} as never} as AssistantMessageEvent;
      await new Promise<void>(()=>{});
    }})};
    const {db,app}=setup(gateway);
    const response=await app.request('/api/v1/sessions/session/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'go',requestId:'4bec5c7c-f8a9-4568-9768-3b888ff16a15',expectedTipEntryId:'opening-entry'})});
    const reader=response.body!.getReader(); await reader.read();
    const deleted=await app.request('/api/v1/worlds/world',{method:'DELETE'});
    expect(deleted.status).toBe(200); expect(db.prepare('SELECT COUNT(*) AS n FROM entries').get()?.n).toBe(0);
    expect((await app.request('/api/v1/sessions/session')).status).toBe(404); db.close();
  });
  it('commits successful tool updates when a later partial reply is stopped', async () => {
    let callCount=0;
    const gateway:ModelGateway = {resolve:()=>model,toolVerified:()=>true,stream:(_m,_c,{signal}) => ({async *[Symbol.asyncIterator]() {
      callCount++;
      if (callCount === 1) {
        yield {type:'done',reason:'toolUse',message:{role:'assistant',content:[{type:'toolCall',id:'call',name:'set_state',arguments:{path:'hero.hp',value:7}}],api:'openai-completions',provider:'fake',model:'fake',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'toolUse',timestamp:0}} as AssistantMessageEvent;
      } else {
        yield {type:'text_delta',delta:'story',contentIndex:0,partial:{} as never} as AssistantMessageEvent;
        await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort',()=>resolve(),{once:true}); });
        yield {type:'error',reason:'aborted',error:{} as never} as AssistantMessageEvent;
      }
    }})};
    const {db,app} = setup(gateway);
    const row=db.prepare('SELECT data_json FROM worlds WHERE id=?').get('world')!; const world=JSON.parse(String(row.data_json));
    world.data.state={schema_version:1,scopes:{message:{modules:{hero:{type:'object',properties:{hp:{type:'integer',initial:10,min:0,max:20}}}}}}};
    db.prepare('UPDATE worlds SET data_json=? WHERE id=?').run(JSON.stringify(world),'world');
    db.prepare('UPDATE entries SET state=? WHERE id=?').run(JSON.stringify([{key:'hero',value:{hp:10}}]),'opening-entry');
    const response = await app.request('/api/v1/sessions/session/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'go',requestId:'4bec5c7c-f8a9-4568-9768-3b888ff16a12',expectedTipEntryId:'opening-entry'})});
    expect(response.status).toBe(200); const runId=response.headers.get('x-run-id'); const reader=response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('story');
    expect((await app.request(`/api/v1/sessions/session/runs/${runId}/stop`,{method:'POST'})).status).toBe(200);
    const state=await (await app.request('/api/v1/sessions/session/state')).json() as {message:{hero:{hp:number}}};
    expect(state.message.hero.hp).toBe(7);
    expect(db.prepare("SELECT COUNT(*) AS n FROM entries WHERE session_id=? AND role='toolResult'").get('session')?.n).toBe(1);
    db.close();
  });
  it('batches long summary inputs and retains all original entries', async () => {
    let summaries=0;
    const assistant = (text:string) => ({role:'assistant' as const,content:[{type:'text' as const,text}],api:'openai-completions',provider:'fake',model:'fake',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop' as const,timestamp:0});
    const gateway:ModelGateway = {resolve:()=>model,toolVerified:()=>true,stream:(_m,context) => ({async *[Symbol.asyncIterator]() {
      const isSummary = context.messages[0]?.role === 'system' && context.messages[0].content === 'summary';
      if (isSummary) summaries++;
      const text = isSummary ? 'short summary' : 'answer';
      yield {type:'text_delta',delta:text,contentIndex:0,partial:{} as never} as AssistantMessageEvent;
      yield {type:'done',reason:'stop',message:assistant(text)} as AssistantMessageEvent;
    }})};
    const {db,app} = setup(gateway); let tip='opening-entry';
    const source = '长'.repeat(12000);
    for (let i=0;i<40;i++) {
      const id=`old-${i}`;
      db.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'session',tip,`old-run-${i}`,i+2,'message','user',1,Date.now(),JSON.stringify({message:{role:'user',content:source}}),null,'{}'); tip=id;
    }
    db.prepare('UPDATE sessions SET tip_entry_id=? WHERE id=?').run(tip,'session');
    const response=await app.request('/api/v1/sessions/session/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'go',requestId:'4bec5c7c-f8a9-4568-9768-3b888ff16a13',expectedTipEntryId:tip})});
    expect(response.status).toBe(200); expect(await response.text()).toBe('answer'); expect(summaries).toBeGreaterThan(1);
    const summary=db.prepare("SELECT ext_data FROM entries WHERE session_id=? AND type='compaction'").get('session');
    const ext=JSON.parse(String(summary?.ext_data)).summary;
    const parts = ext.generation.flatMap((item:{request:{chunks:Array<{sourceEntryId:string; text:string}>}})=>item.request.chunks);
    for (let i=0;i<29;i++) expect(parts.filter((p:{sourceEntryId:string})=>p.sourceEntryId===`old-${i}`).map((p:{text:string})=>p.text).join('')).toBe(source);
    expect(db.prepare("SELECT COUNT(*) AS n FROM entries WHERE id LIKE 'old-%'").get()?.n).toBe(40);
    db.close();
  });
  it('reports budget overflow before persisting the user message', async () => {
    const tiny={...model,contextWindow:1100};
    const gateway:ModelGateway={resolve:()=>tiny,toolVerified:()=>true,stream:()=>({async *[Symbol.asyncIterator]() { throw new Error('provider should not be called'); }})};
    const {db,app}=setup(gateway);
    const response=await app.request('/api/v1/sessions/session/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'hello',requestId:'4bec5c7c-f8a9-4568-9768-3b888ff16a16',expectedTipEntryId:'opening-entry'})});
    expect(response.status).toBe(422);
    expect((await response.json() as {error:{code:string}}).error.code).toBe('CONTEXT_BUDGET_EXCEEDED');
    expect(db.prepare('SELECT COUNT(*) AS n FROM entries').get()?.n).toBe(1);
    db.close();
  });
  it('rejects missing credentials and an unverified stateful model before writing', async () => {
    const gateway:ModelGateway={resolve:()=>model,toolVerified:()=>false,stream:()=>({async *[Symbol.asyncIterator]() {}})};
    const {db}=setup(gateway);
    const missing:CredentialStore={async set(){},async get(){return null;},async delete(){}};
    const app=createApp(db,missing,gateway);
    const payload={text:'go',requestId:'4bec5c7c-f8a9-4568-9768-3b888ff16a18',expectedTipEntryId:'opening-entry'};
    const absent=await app.request('/api/v1/sessions/session/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
    expect((await absent.json() as {error:{code:string}}).error.code).toBe('CREDENTIAL_NOT_CONFIGURED');
    const worldRow=db.prepare('SELECT data_json FROM worlds WHERE id=?').get('world')!;const world=JSON.parse(String(worldRow.data_json));
    world.data.state={schema_version:1,scopes:{message:{modules:{hero:{type:'object',properties:{hp:{type:'integer',initial:10}}}}}}};
    db.prepare('UPDATE worlds SET data_json=? WHERE id=?').run(JSON.stringify(world),'world');
    db.prepare('UPDATE entries SET state=? WHERE id=?').run(JSON.stringify([{key:'hero',value:{hp:10}}]),'opening-entry');
    const present=createApp(db,new MemoryCredentials(),gateway);
    const blocked=await present.request('/api/v1/sessions/session/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
    expect((await blocked.json() as {error:{code:string}}).error.code).toBe('MODEL_TOOL_UNSUPPORTED');
    expect(db.prepare('SELECT COUNT(*) AS n FROM entries').get()?.n).toBe(1);db.close();
  });
  it('can stop a summary before the streaming response has started', async () => {
    let notify!:()=>void; const started=new Promise<void>(resolve=>{notify=resolve;});
    const gateway:ModelGateway={resolve:()=>model,toolVerified:()=>true,stream:()=>({async *[Symbol.asyncIterator]() {notify(); await new Promise<void>(()=>{});}})};
    const {db,app}=setup(gateway);let tip='opening-entry';
    for(let i=0;i<40;i++) {const id=`stop-h${i}`;db.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'session',tip,`stop-r${i}`,i+2,'message','user',1,Date.now(),JSON.stringify({message:{role:'user',content:'old'}}),null,'{}');tip=id;}
    db.prepare('UPDATE sessions SET tip_entry_id=? WHERE id=?').run(tip,'session');
    const pending=app.request('/api/v1/sessions/session/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'new',requestId:'4bec5c7c-f8a9-4568-9768-3b888ff16a21',expectedTipEntryId:tip})});
    await started;
    const stopped=await app.request('/api/v1/sessions/session/stop',{method:'POST'});
    expect((await stopped.json() as {status:string}).status).toBe('stopped');
    expect((await (await pending).json() as {error:{code:string}}).error.code).toBe('RUN_STOPPED');
    expect(db.prepare('SELECT COUNT(*) AS n FROM entries').get()?.n).toBe(41);db.close();
  });
  it('does not persist user or summary when summary generation fails', async () => {
    const gateway:ModelGateway={resolve:()=>model,toolVerified:()=>true,stream:()=>({async *[Symbol.asyncIterator]() {yield {type:'error',reason:'error',error:{} as never} as AssistantMessageEvent;}})};
    const {db,app}=setup(gateway);let tip='opening-entry';
    for(let i=0;i<40;i++) {const id=`h${i}`;db.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'session',tip,`r${i}`,i+2,'message','user',1,Date.now(),JSON.stringify({message:{role:'user',content:'old'}}),null,'{}');tip=id;}
    db.prepare('UPDATE sessions SET tip_entry_id=? WHERE id=?').run(tip,'session');
    const response=await app.request('/api/v1/sessions/session/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'new',requestId:'4bec5c7c-f8a9-4568-9768-3b888ff16a19',expectedTipEntryId:tip})});
    expect((await response.json() as {error:{code:string}}).error.code).toBe('SUMMARY_FAILED');
    expect(db.prepare('SELECT COUNT(*) AS n FROM entries').get()?.n).toBe(41);db.close();
  });
  it('retains emitted text and reports failure when state commit fails', async () => {
    const gateway:ModelGateway={resolve:()=>model,toolVerified:()=>true,stream:()=>({async *[Symbol.asyncIterator]() {
      yield {type:'text_delta',delta:'visible',contentIndex:0,partial:{} as never} as AssistantMessageEvent;
      yield {type:'done',reason:'stop',message:{role:'assistant',content:[{type:'text',text:'visible'}],api:'openai-completions',provider:'fake',model:'fake',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:0}} as AssistantMessageEvent;
    }})};
    const {db,app}=setup(gateway);
    db.exec("CREATE TRIGGER fail_state BEFORE UPDATE OF state ON entries WHEN NEW.state IS NOT NULL BEGIN SELECT RAISE(ABORT,'fail'); END");
    const response=await app.request('/api/v1/sessions/session/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'go',requestId:'4bec5c7c-f8a9-4568-9768-3b888ff16a22',expectedTipEntryId:'opening-entry'})});
    expect(await response.text()).toBe('visible');
    const status=await (await app.request(`/api/v1/sessions/session/runs/${response.headers.get('x-run-id')}`)).json() as {status:string;error:string};
    expect(status.status).toBe('failed');expect(status.error).toBe('STATE_COMMIT_FAILED');
    const state=await (await app.request('/api/v1/sessions/session/state')).json() as {message:object};expect(state.message).toEqual({});db.close();
  });
  it('rejects missing preset before adding a user entry', async () => {
    const gateway:ModelGateway = {resolve:()=>model,toolVerified:()=>true,stream:()=>({async *[Symbol.asyncIterator]() {}})};
    const {db,app} = setup(gateway); db.prepare('UPDATE sessions SET preset_id=NULL WHERE id=?').run('session');
    const response = await app.request('/api/v1/sessions/session/runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'hello',requestId:'4bec5c7c-f8a9-4568-9768-3b888ff16a11',expectedTipEntryId:'opening-entry'})});
    expect(response.status).toBe(422); expect((await response.json() as {error:{code:string}}).error.code).toBe('PRESET_NOT_SELECTED');
    expect(db.prepare('SELECT count(*) AS n FROM entries').get()?.n).toBe(1); db.close();
  });
});
