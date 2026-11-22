import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHistoryController,projectRun} from '../src/features/history/controller.ts';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const entry=(seq,runId='r',role='assistant')=>({id:'e'+seq,sessionId:'s',parentId:seq>1?'e'+(seq-1):null,runId,seq,type:'message',role,timestamp:seq,payload:{message:{role,content:'Text '+seq}},state:null,extData:{},metrics:null,createdAt:seq,updatedAt:seq});
const run=(id,seqs,status='completed')=>({runId:id,firstSeq:seqs[0],lastSeq:seqs.at(-1),entries:seqs.map(seq=>entry(seq,id)),status});
const page=(items,extra={})=>({items,hasMore:false,nextCursor:null,nextAfterSeq:items.length?Math.max(...items.map(run=>run.lastSeq)):null,activeRunId:null,...extra});
test('newest and older pages share one entry store and old pages never lower the forward checkpoint',async()=>{
 const calls=[],responses=[page([run('b',[8,9,10])],{hasMore:true,nextCursor:'older'}),page([run('a',[1,2])])];
 const history=createHistoryController({sessionId:'s',request:async path=>{calls.push(path);return responses.shift();}});
 await history.loadRecent();await history.loadOlder();
 assert.equal(calls[1],'v1/sessions/s/narrative/runs?cursor=older');
 assert.equal(history.getSnapshot().afterSeq,10);
 assert.deepEqual(history.getSnapshot().runs.flatMap(run=>run.entries).map(value=>value.seq),[1,2,8,9,10]);
 assert.deepEqual(history.getSnapshot().runs.map(value=>value.runId),['a','b']);
 assert.equal(history.getSnapshot().hasMore,false);
});
test('catch-up drains every forward page, replaces complete runs and preserves checkpoint on empty results',async()=>{
 const responses=[page([run('r',[1])],{activeRunId:'r'}),page([run('r',[1,2])],{hasMore:true}),page([run('next',[3,4])]),page([])];
 const calls=[],history=createHistoryController({sessionId:'s',request:async path=>{calls.push(path);return responses.shift();}});
 await history.loadRecent();await history.catchUp();await history.catchUp();
 assert.deepEqual(calls.slice(1),['v1/sessions/s/narrative/runs?afterSeq=1','v1/sessions/s/narrative/runs?afterSeq=2','v1/sessions/s/narrative/runs?afterSeq=4']);
 assert.equal(history.getSnapshot().afterSeq,4);
 assert.deepEqual(history.getSnapshot().runs.flatMap(run=>run.entries).map(value=>value.id),['e1','e2','e3','e4']);
});
test('late running reads cannot erase terminal metadata, output, or the larger lastSeq',async()=>{
 const waiting=deferred();
 const completed=run('r',[1,2]);completed.entries[0].extData.narrative={status:'completed',finishedAt:3};
 completed.entries[1].extData.output={actionSuggestions:{status:'success',items:['走']}};
 const responses=[page([run('r',[1],'running')],{hasMore:true,nextCursor:'older',activeRunId:'r'}),waiting.promise,page([completed])];
 const history=createHistoryController({sessionId:'s',request:async()=>responses.shift()});
 await history.loadRecent();const loading=history.loadOlder();await history.catchUp();
 waiting.resolve(page([run('r',[1],'running')]));await loading;
 assert.equal(history.getSnapshot().runs[0].status,'completed');
 assert.equal(history.getSnapshot().runs[0].lastSeq,2);
 assert.equal(history.getSnapshot().runs[0].entries[0].extData.narrative.status,'completed');
 assert.ok(history.getSnapshot().runs[0].entries[1].extData.output);
 assert.equal(history.getSnapshot().activeRunId,null);
});
test('compaction advances the saved sequence but is not projected as a chat message',async()=>{
 const stored=run('r',[1,2]);
 stored.entries[1]={...stored.entries[1],type:'compaction',role:null,payload:{summary:'Summary'}};
 const history=createHistoryController({sessionId:'s',request:async()=>page([stored])});
 await history.loadRecent();
 assert.equal(history.getSnapshot().afterSeq,2);
 assert.equal(projectRun(history.getSnapshot().runs[0]).messages.length,1);
});

test('reconnect overlaps the last running seq to capture a terminal outcome without a new entry',async()=>{
 const calls=[],responses=[page([run('r',[7],'running')],{activeRunId:'r'}),page([run('r',[7],'stopped')])];
 const history=createHistoryController({sessionId:'s',request:async path=>{calls.push(path);return responses.shift();}});
 await history.loadRecent();await history.catchUp();
 assert.equal(calls[1],'v1/sessions/s/narrative/runs?afterSeq=6');
 assert.equal(history.getSnapshot().afterSeq,7);
 assert.equal(history.getSnapshot().runs[0].status,'stopped');
});

test('broken forward pagination terminates and disposing rejects late reads without mutating state',async()=>{
 const history=createHistoryController({sessionId:'s',request:async()=>page([],{hasMore:true,nextAfterSeq:0})});
 await assert.rejects(history.catchUp(),/未前进/);
 const waiting=deferred(),other=createHistoryController({sessionId:'s',request:()=>waiting.promise});
 const loading=other.loadRecent();other.dispose();waiting.resolve(page([run('r',[1])]));
 await assert.rejects(loading,{name:'AbortError'});assert.equal(other.getSnapshot().runs.length,0);
});

test('history passes compact capability diagnostics to stage messages without duplicating results',async()=>{
 const stored=run('r',[1,2]);
 const output={stateUpdate:{status:'partial_success',updates:[
  {status:'success',path:'coins',value:8,reason:'Bought food'},
  {status:'invalid_json',errorCode:'STATE_UPDATE_JSON_INVALID'},
  {status:'invalid_value',path:'energy',value:-1,errorCode:'STATE_VALUE_INVALID'}
 ]},actionSuggestions:{status:'partial_success',items:['Ask the keeper.']}};
 stored.entries[1].extData.output=structuredClone(output);
 const history=createHistoryController({sessionId:'s',request:async()=>page([stored])});
 await history.loadRecent();
 const message=projectRun(history.getSnapshot().runs[0]).messages[1];
 assert.deepEqual(message.output,output);
 assert.equal('results' in message.output.stateUpdate,false);
 assert.equal('results' in message.output.actionSuggestions,false);
 stored.entries[1].extData.output.stateUpdate.updates[0].value=99;
 assert.equal(message.output.stateUpdate.updates[0].value,8);
});

test('deletion invalidates pending pages and accepts a shorter authoritative history',async()=>{
 const old=deferred(),responses=[page([run('r',[1,2])]),old.promise,page([{...run('r',[1],'stopped'),assistantEntryId:'new-a'}])];
 const history=createHistoryController({sessionId:'s',request:async()=>responses.shift()});
 await history.loadRecent();const pending=history.catchUp();
 history.acceptExecution({runId:'r',assistantEntryId:'new-a',deletedMessageIds:['e2']});
 old.resolve(page([run('r',[1,2])]));await pending;
 assert.deepEqual(history.getSnapshot().runs[0].entries.map(entry=>entry.id),['e1']);
 assert.equal(history.getSnapshot().runs[0].status,'running');
 await history.loadRecent(true);
 assert.equal(history.getSnapshot().afterSeq,1);assert.equal(history.getSnapshot().runs[0].status,'stopped');
 assert.equal(history.getSnapshot().hasMore,false);
});
