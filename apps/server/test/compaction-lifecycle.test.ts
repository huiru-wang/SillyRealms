import {expect,it} from 'vitest';
import type {DatabaseSync} from 'node:sqlite';
import type {Context} from '@earendil-works/pi-ai';
import {runtimeFixture,textGateway,testModel,response,tail,drain} from './fixtures/runtime-v2.js';

function oldHistory(db:DatabaseSync,size:number){
  let parent='opening',seq=2;
  for(let i=1;i<=6;i++)for(const role of ['user','assistant']){
    const id='old-'+role+'-'+i,text=role==='assistant'&&i===1?'H'.repeat(size):role+' '+i;
    db.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,branch_count,timestamp,payload,state,ext_data) VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?)')
      .run(id,'session',parent,'old-run-'+i,seq++,'message',role,1,1,JSON.stringify({message:{role,content:text}}),
        JSON.stringify({run:{status:'completed'}}));
    parent=id;
  }
  db.prepare('UPDATE sessions SET tip_entry_id=? WHERE id=?').run(parent,'session');
  return parent;
}
const summaries=(db:DatabaseSync)=>db.prepare("SELECT * FROM entries WHERE type='compaction'").all();
const usage=(db:DatabaseSync)=>JSON.parse(String(db.prepare("SELECT usage_json FROM sessions WHERE id='session'").get()!.usage_json));
const score=(db:DatabaseSync)=>JSON.parse(String(db.prepare('SELECT state FROM entries WHERE state IS NOT NULL ORDER BY seq DESC LIMIT 1').get()!.state)).find((v:any)=>v.key==='score').value;
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
it.each([false,true])('initial compaction and user entry commit atomically (reject insert=%s)',async reject=>{
  let summaryCalls=0,generationCalls=0;
  const gateway=textGateway('unused');gateway.resolve=()=>({...testModel,contextWindow:8192});
  gateway.stream=(_model,_context,options)=>({async *[Symbol.asyncIterator](){
    if(options.maxTokens===2048){summaryCalls++;yield {type:'done' as const,reason:'stop' as const,message:response('旧情节摘要')};}
    else {expect(options.maxTokens).toBe(128);generationCalls++;yield {type:'done' as const,reason:'stop' as const,message:response('新的故事。'+tail())};}
  }});
  const {db,runtime}=runtimeFixture(gateway);
  try{
    const tip=oldHistory(db,14000),original=db.prepare('SELECT count(*) AS n FROM entries').get()!.n;
    if(reject){
      db.exec("CREATE TRIGGER reject_new_user BEFORE INSERT ON entries WHEN NEW.role='user' AND NEW.id NOT LIKE 'old-%' BEGIN SELECT RAISE(ABORT,'test insertion failure'); END");
      await expect(runtime.prepare('session','继续','initial',tip)).rejects.toThrow();
      expect(summaries(db)).toHaveLength(0);expect(generationCalls).toBe(0);
      expect(db.prepare("SELECT tip_entry_id FROM sessions WHERE id='session'").get()!.tip_entry_id).toBe(tip);
      expect(db.prepare('SELECT count(*) AS n FROM entries').get()!.n).toBe(original);
      expect(usage(db).unattachedTotals.reportedCount).toBe(summaryCalls);
      expect(db.prepare('SELECT input_text,status FROM run_preparations').get()).toMatchObject({input_text:'继续',status:'failed'});
    }else{
      const run=await runtime.prepare('session','继续','initial',tip);await drain(run.stream);
      expect(runtime.status('session',run.runId)?.status).toBe('completed');
      const [summary]=summaries(db);expect(summary).toBeTruthy();
      expect(JSON.parse(String(summary!.ext_data)).summary.coveredThroughEntryId).toBe('old-assistant-1');
      const user=db.prepare("SELECT seq FROM entries WHERE run_id=? AND role='user'").get(run.runId)!;
      expect(Number(summary!.seq)).toBeLessThan(Number(user.seq));expect(generationCalls).toBe(1);
      expect(db.prepare("SELECT count(*) AS n FROM entries WHERE id LIKE 'old-%'").get()!.n).toBe(12);
    }
    expect(summaryCalls).toBe(1);expect(usage(db).pendingRun).toBeNull();
    expect(runtime.busy('session')).toBe(false);
  }finally{db.close();}
});
it.each(['completed','failed','stopped'] as const)('initial compaction persists while Agent continuations honor %s finalization',async outcome=>{
  const reached=deferred(),release=deferred();let summaryCalls=0,generationCalls=0,continuation:Context|undefined;
  const gateway=textGateway('unused');gateway.resolve=()=>({...testModel,contextWindow:8192});
  gateway.stream=(_model,context,options)=>({async *[Symbol.asyncIterator](){
    if(options.maxTokens===2048){summaryCalls++;yield {type:'done' as const,reason:'stop' as const,message:response('旧情节摘要')};return;}
    expect(options.maxTokens).toBe(128);generationCalls++;
    if(generationCalls===1){
      yield {type:'done' as const,reason:'toolUse' as const,message:{...response('','toolUse'),
        content:[{type:'toolCall' as const,id:'state-change',name:'update_state',arguments:{updates:[{path:'score',value:2}],padding:'x'.repeat(13000)}}]}};
      return;
    }
    continuation=context;reached.resolve();options.signal.addEventListener('abort',release.resolve,{once:true});
    await release.promise;
    if(outcome==='failed')throw Error('test provider failure');
    yield {type:'done' as const,reason:'stop' as const,message:response('工具之后的故事')};
  }});
  const {db,runtime}=runtimeFixture(gateway,'agent');
  try{
    const tip=oldHistory(db,14000),run=await runtime.prepare('session','继续','continuation',tip),done=drain(run.stream);
    await reached.promise;
    expect(summaryCalls).toBeGreaterThan(0);expect(summaries(db)).toHaveLength(1);expect(score(db)).toBe(0);
    expect(continuation!.messages.slice(-2).map(message=>message.role)).toEqual(['assistant','toolResult']);
    expect(continuation!.messages.at(-1)).toMatchObject({toolCallId:'state-change'});
    if(outcome==='stopped')await runtime.stop('session',run.runId);else release.resolve();
    await done;
    expect(runtime.status('session',run.runId)?.status).toBe(outcome);
    expect(score(db)).toBe(outcome==='failed'?0:2);
    const rows=summaries(db);expect(rows).toHaveLength(1);
    if(rows[0]){
      expect(JSON.parse(String(rows[0].ext_data)).summary.coveredThroughEntryId).toBe('old-assistant-1');
      const covered=db.prepare('SELECT seq FROM entries WHERE id=?').get('old-assistant-1')!;
      const user=db.prepare("SELECT seq FROM entries WHERE run_id=? AND role='user'").get(run.runId)!;
      expect(Number(covered.seq)).toBeLessThan(Number(user.seq));
    }
    expect(db.prepare("SELECT count(*) AS n FROM entries WHERE id LIKE 'old-%'").get()!.n).toBe(12);
    expect(usage(db).pendingRun).toBeNull();expect(runtime.busy('session')).toBe(false);
  }finally{release.resolve();db.close();}
});
it('rejects an oversized complete summary without batching or model calls',async()=>{
  let summariesSent=0,generations=0;
  const gateway=textGateway('unused');gateway.resolve=()=>({...testModel,contextWindow:8192});
  gateway.stream=(_model,_context,options)=>({async *[Symbol.asyncIterator](){
    if(options.maxTokens===2048)summariesSent++;else generations++;
    yield {type:'done' as const,reason:'stop' as const,message:response('有限摘要')};
  }});
  const {db,runtime}=runtimeFixture(gateway);
  try{
    const tip=oldHistory(db,150000),original=db.prepare('SELECT count(*) AS n FROM entries').get()!.n;
    await expect(runtime.prepare('session','继续','bounded',tip)).rejects.toMatchObject({code:'SUMMARY_CAPACITY_EXCEEDED'});
    expect(summariesSent).toBe(0);expect(generations).toBe(0);expect(summaries(db)).toHaveLength(0);
    expect(db.prepare('SELECT count(*) AS n FROM entries').get()!.n).toBe(original);
    expect(usage(db)).toMatchObject({pendingRun:null,cumulative:{reportedCount:0,inputTokens:0,outputTokens:0}});
    expect(runtime.busy('session')).toBe(false);expect(runtime.worldBusy('world')).toBe(false);
  }finally{db.close();}
});

it.each([
  { strategy:'sliding_window', source:'discarded', active:false },
  { strategy:'sliding_window', source:'input', active:true },
  { strategy:'sliding_window', source:'retained', active:true },
  { strategy:'rolling_summary', source:'summary', active:true },
  { strategy:'rolling_summary', source:'discarded', active:false },
] as const)('activates only the final $strategy context from $source',async({strategy,source,active})=>{
  let sent:Context|undefined,calls=0;
  const gateway=textGateway('unused');
  gateway.stream=(_model,context,options)=>({async *[Symbol.asyncIterator](){
    if(options.maxTokens===2048){calls++;yield {type:'done' as const,reason:'stop' as const,message:response(source==='summary'?'forest summary':'past events')};return;}
    sent=context;
    yield {type:'done' as const,reason:'stop' as const,message:response('story'+tail())};
  }});
  const {db,runtime,preset}=runtimeFixture(gateway);
  try{
    preset.budget={strategy,max_context_tokens:3500,max_output_tokens:128};
    db.prepare('UPDATE presets SET config_json=?').run(JSON.stringify(preset));
    db.prepare('UPDATE worlds SET characters_json=?,lorebook_json=?,state_definition_json=? WHERE id=?').run(
      JSON.stringify([{id:'p',name:'Player',player_selectable:true,prompt:'PLAYER_NEVER',load:{mode:'never'}},
        {id:'n',name:'NPC',prompt:'NPC_FINAL',load:{mode:'on_mention',keywords:['forest']}}]),
      JSON.stringify({entries:[{id:'l',content:'LORE_FINAL cascade',load:{mode:'on_mention',keywords:['forest'],exclude_keywords:['poison']}},
        {id:'cascade',content:'NO_RECURSIVE_LOAD',load:{mode:'on_mention',keywords:['cascade']}},
        {id:'when',content:'WHEN_MUST_FAIL',load:{mode:'always',when:'getState("score") > 0'}}]}),
      JSON.stringify({schema_version:1,scopes:{message:{score:{type:'number',initial:0,min:0,load:{mode:'on_mention',keywords:['forest']}}}}}),'world');
    const tip=oldHistory(db,14000);
    db.prepare('UPDATE entries SET payload=? WHERE id=?').run(JSON.stringify({message:{role:'assistant',content:'forest poison '+'H'.repeat(14000)}}),'old-assistant-1');
    if(source==='retained')db.prepare('UPDATE entries SET payload=? WHERE id=?').run(JSON.stringify({message:{role:'assistant',content:'forest'}}),tip);
    const run=await runtime.prepare('session',source==='input'?'forest':'continue','activation',tip);await drain(run.stream);
    expect(runtime.status('session',run.runId)?.status).toBe('completed');
    const payload=JSON.stringify(sent);
    expect(payload.includes('NPC_FINAL')).toBe(active);expect(payload.includes('LORE_FINAL')).toBe(active);
    expect(payload).not.toContain('PLAYER_NEVER');expect(payload).not.toContain('NO_RECURSIVE_LOAD');expect(payload).not.toContain('WHEN_MUST_FAIL');
    const ext=JSON.parse(String(db.prepare("SELECT ext_data FROM entries WHERE run_id=? AND role='user'").get(run.runId)!.ext_data));
    expect(ext.runtime.active).toEqual(active?['score']:[]);
    expect(runtime.status('session',run.runId)?.capabilities.stateUpdate.required).toBe(active);
    expect(score(db)).toBe(0);expect(calls).toBe(strategy==='rolling_summary'?1:0);
  }finally{db.close();}
});
it('fails once on summary Provider overflow, retains safe cause and usage, and never starts generation',async()=>{
  let calls=0;
  const gateway=textGateway('unused');gateway.resolve=()=>({...testModel,contextWindow:8192});
  gateway.stream=()=>({async *[Symbol.asyncIterator](){calls++;
    yield {type:'error' as const,reason:'error' as const,error:{...response('','error'),errorMessage:'400: {"error":{"code":"context_length_exceeded","message":"PRIVATE UPSTREAM"}}'}};
  }});
  const {db,runtime}=runtimeFixture(gateway);
  try{
    const tip=oldHistory(db,14000);
    await expect(runtime.prepare('session','saved input','summary-failure',tip)).rejects.toMatchObject({code:'SUMMARY_FAILED'});
    const record=db.prepare('SELECT * FROM run_preparations').get()!;
    expect(JSON.parse(String(record.result_json))).toMatchObject({diagnostics:{causeCode:'PROVIDER_CONTEXT_WINDOW_EXCEEDED'}});
    const result=runtime.status('session',String(record.run_id));
    expect(result).toMatchObject({status:'failed',input:{text:'saved input'},failure:{stage:'preparation',type:'summary'},recovery:{inputSaved:true,action:'adjust_configuration'}});
    expect(JSON.stringify(result)).not.toContain('causeCode');expect(JSON.stringify(record)).not.toContain('PRIVATE UPSTREAM');
    expect(calls).toBe(1);expect(summaries(db)).toHaveLength(0);
    expect(usage(db).cumulative).toMatchObject({reportedCount:1,inputTokens:20,outputTokens:10});
  }finally{db.close();}
});
it('rejects a changed summary source at the atomic handoff and keeps the input',async()=>{
  let calls=0;
  const gateway=textGateway('unused');gateway.resolve=()=>({...testModel,contextWindow:8192});
  gateway.stream=()=>({async *[Symbol.asyncIterator](){calls++;yield {type:'done' as const,reason:'stop' as const,message:response('summary')};}});
  const {db,runtime}=runtimeFixture(gateway);
  try{
    const tip=oldHistory(db,14000);
    gateway.preview=async(_model,_context,options)=>{
      if(options.maxTokens===128)db.prepare('UPDATE entries SET payload=? WHERE id=?')
        .run(JSON.stringify({message:{role:'assistant',content:'changed source'}}),'old-assistant-1');
      return undefined;
    };
    await expect(runtime.prepare('session','recover me','source-change',tip)).rejects.toMatchObject({code:'INVALID_SUMMARY_BOUNDARY'});
    expect(calls).toBe(1);expect(summaries(db)).toHaveLength(0);
    expect(db.prepare('SELECT tip_entry_id FROM sessions').get()!.tip_entry_id).toBe(tip);
    expect(db.prepare('SELECT input_text,status FROM run_preparations').get()).toMatchObject({input_text:'recover me',status:'failed'});
  }finally{db.close();}
});
