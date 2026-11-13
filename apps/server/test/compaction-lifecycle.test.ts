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
    else {generationCalls++;yield {type:'done' as const,reason:'stop' as const,message:response('新的故事。'+tail())};}
  }});
  const {db,runtime}=runtimeFixture(gateway);
  try{
    const tip=oldHistory(db,60000),original=db.prepare('SELECT count(*) AS n FROM entries').get()!.n;
    if(reject){
      db.exec("CREATE TRIGGER reject_new_user BEFORE INSERT ON entries WHEN NEW.role='user' AND NEW.id NOT LIKE 'old-%' BEGIN SELECT RAISE(ABORT,'test insertion failure'); END");
      await expect(runtime.prepare('session','继续','initial',tip)).rejects.toThrow();
      expect(summaries(db)).toHaveLength(0);expect(generationCalls).toBe(0);
      expect(db.prepare("SELECT tip_entry_id FROM sessions WHERE id='session'").get()!.tip_entry_id).toBe(tip);
      expect(db.prepare('SELECT count(*) AS n FROM entries').get()!.n).toBe(original);
      expect(usage(db).unattachedTotals.reportedCount).toBe(summaryCalls);
    }else{
      const run=await runtime.prepare('session','继续','initial',tip);await drain(run.stream);
      expect(runtime.status('session',run.runId)?.status).toBe('completed');
      const [summary]=summaries(db);expect(summary).toBeTruthy();
      expect(JSON.parse(String(summary!.ext_data)).summary.coveredThroughEntryId).toBe('old-assistant-1');
      const user=db.prepare("SELECT seq FROM entries WHERE run_id=? AND role='user'").get(run.runId)!;
      expect(Number(summary!.seq)).toBeLessThan(Number(user.seq));expect(generationCalls).toBe(1);
      expect(db.prepare("SELECT count(*) AS n FROM entries WHERE id LIKE 'old-%'").get()!.n).toBe(12);
    }
    expect(summaryCalls).toBeGreaterThan(1);expect(usage(db).pendingRun).toBeNull();
    expect(runtime.busy('session')).toBe(false);
  }finally{db.close();}
});
it.each(['completed','failed','stopped'] as const)('continuation compaction and Agent workspace honor %s finalization',async outcome=>{
  const reached=deferred(),release=deferred();let summaryCalls=0,generationCalls=0,continuation:Context|undefined;
  const gateway=textGateway('unused');gateway.resolve=()=>({...testModel,contextWindow:8192});
  gateway.stream=(_model,context,options)=>({async *[Symbol.asyncIterator](){
    if(options.maxTokens===2048){summaryCalls++;yield {type:'done' as const,reason:'stop' as const,message:response('旧情节摘要')};return;}
    generationCalls++;
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
    expect(summaryCalls).toBeGreaterThan(0);expect(summaries(db)).toHaveLength(0);expect(score(db)).toBe(0);
    expect(continuation!.messages.slice(-2).map(message=>message.role)).toEqual(['assistant','toolResult']);
    expect(continuation!.messages.at(-1)).toMatchObject({toolCallId:'state-change'});
    if(outcome==='stopped')await runtime.stop('session',run.runId);else release.resolve();
    await done;
    expect(runtime.status('session',run.runId)?.status).toBe(outcome);
    expect(score(db)).toBe(outcome==='failed'?0:2);
    const rows=summaries(db);expect(rows).toHaveLength(outcome==='stopped'?0:1);
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
it('stops at eight summary requests before generation and retains their real usage',async()=>{
  let summariesSent=0,generations=0;
  const gateway=textGateway('unused');gateway.resolve=()=>({...testModel,contextWindow:8192});
  gateway.stream=(_model,_context,options)=>({async *[Symbol.asyncIterator](){
    if(options.maxTokens===2048)summariesSent++;else generations++;
    yield {type:'done' as const,reason:'stop' as const,message:response('有限摘要')};
  }});
  const {db,runtime}=runtimeFixture(gateway);
  try{
    const tip=oldHistory(db,150000),original=db.prepare('SELECT count(*) AS n FROM entries').get()!.n;
    await expect(runtime.prepare('session','继续','bounded',tip)).rejects.toMatchObject({code:'CONTEXT_BUDGET_EXCEEDED'});
    expect(summariesSent).toBe(8);expect(generations).toBe(0);expect(summaries(db)).toHaveLength(0);
    expect(db.prepare('SELECT count(*) AS n FROM entries').get()!.n).toBe(original);
    expect(usage(db)).toMatchObject({pendingRun:null,cumulative:{reportedCount:8,inputTokens:160,outputTokens:80},
      unattachedTotals:{reportedCount:8}});
    expect(runtime.busy('session')).toBe(false);expect(runtime.worldBusy('world')).toBe(false);
  }finally{db.close();}
});
