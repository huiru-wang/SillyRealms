import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {createNarrativeController,appendMessageDelta} from '../src/features/narrative/controller.ts';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const fields=(runId='r')=>({sessionId:'s',runId,provider:'test',model:'model',timestamp:10});
const created=(runId='r')=>({event:'run.created',data:{...fields(runId),messages:[{id:runId+'-u',role:'user',content:'Input',timestamp:1}]}});
const delta=(content,extra={},runId='r')=>({event:'run.delta',data:{...fields(runId),messageId:runId+'-a',messages:[{role:'assistant',delta:{content},...extra}]}});
const completed=(runId='r')=>({event:'run.completed',data:{...fields(runId),savedMessageIds:[runId+'-u',runId+'-a'],tipEntryId:runId+'-a'}});
const entry=(id,role,seq,runId='r')=>({id,sessionId:'s',parentId:null,runId,seq,type:'message',role,timestamp:seq,payload:{message:{role,content:role==='user'?'Input':'Saved'}},state:null,extData:{},metrics:null,createdAt:seq,updatedAt:seq});
const stored=(status='running',assistant=false,runId='r')=>({runId,status,firstSeq:1,lastSeq:assistant?2:1,entries:[entry(runId+'-u','user',1,runId),...(assistant?[entry(runId+'-a','assistant',2,runId)]:[])],...(status==='stopped'?{stopReason:'provider_error'}:{})});
const finalSnapshot={role:'assistant',content:'Corrected',reasoning_content:'',tool_calls:[]};

test('POST uses the actual compaction tip; an entire lifecycle before 202 never restarts the completed run',async()=>{
 const post=deferred(),calls=[];
 const client=createNarrativeController({sessionId:'s',getSession:async()=>({tipEntryId:'summary-tip'}),
  request:async(path,init)=>{calls.push({path,init});assert.equal(init.method,'POST');return post.promise;},
 });
 const sending=client.send('  Original input  ');await nextTurn();
 assert.deepEqual(JSON.parse(calls[0].init.body),{input:{text:'  Original input  '},expectedTipEntryId:'summary-tip'});
 client.accept(created());client.accept(delta('Draft'));
 await assert.rejects(client.send('Duplicate'),/仍在生成/);
 client.accept(delta('',{snapshot:finalSnapshot,finish_reason:'stop'}));
 assert.equal(client.getSnapshot().activeRunId,'r');
 assert.equal(client.getSnapshot().drafts.at(-1).content,'Corrected');
 assert.equal(client.getSnapshot().drafts.at(-1).saved,false);
 client.accept(completed());client.reconcile(stored('completed',true),client.checkpoint());
 post.resolve({runId:'r',userEntryId:'r-u',assistantEntryId:'r-a'});await sending;
 assert.equal(client.getSnapshot().run.status,'completed');
 assert.equal(client.getSnapshot().activeRunId,null);
 assert.deepEqual(client.getSnapshot().drafts,[]);
 assert.equal(calls.filter(call=>call.init?.method==='POST').length,1);
});
test('a failed assistant save drops its streamed body even when history is temporarily unavailable',()=>{
 const client=createNarrativeController({sessionId:'s',request:assert.fail,getSession:assert.fail});
 client.accept(created());client.accept(delta('Unsaved'));
 client.accept({event:'run.stopped',data:{...fields(),savedMessageIds:['r-u'],tipEntryId:'r-u',stop_reason:'message_persist_failed'}});
 assert.deepEqual(client.getSnapshot().run.messages.map(message=>message.id),['r-u']);
 client.reconcile(stored('stopped'),client.checkpoint());
 assert.deepEqual(client.getSnapshot().drafts,[]);
});
test('deltas append fields and tool arguments while final snapshots replace every public field',()=>{
 const result=appendMessageDelta({role:'assistant',content:'A',reasoning_content:'Think',tool_calls:[]},{
  content:'B',reasoning_content:' more',tool_calls:[{index:2,id:'tool',function:{name:'lookup',arguments:'{"q":'}}],
 });
 const next=appendMessageDelta(result,{tool_calls:[{index:2,function:{arguments:'1}'}}]});
 assert.equal(next.content,'AB');assert.equal(next.reasoning_content,'Think more');
 assert.deepEqual(next.tool_calls,[{index:2,id:'tool',type:'function',function:{name:'lookup',arguments:'{"q":1}'}}]);
 const client=createNarrativeController({sessionId:'s',getSession:async()=>({tipEntryId:null}),request:assert.fail});
 client.accept(created());client.accept(delta('Old',{delta:{content:'Old',reasoning_content:'Reason',tool_calls:[{index:0,id:'x',function:{name:'x',arguments:'{}'}}]}}));
 client.accept(delta('',{snapshot:finalSnapshot}));
 assert.deepEqual(client.getSnapshot().drafts.at(-1).tool_calls,[]);
 assert.equal(client.getSnapshot().drafts.at(-1).reasoning_content,'');
 assert.equal(client.getSnapshot().drafts.at(-1).content,'Corrected');
 client.dispose();
});
test('lost-stream deltas are not fabricated into a continuous message, but the final snapshot repairs it',async()=>{
 const client=createNarrativeController({sessionId:'s',getSession:async()=>({tipEntryId:null}),request:assert.fail});
 client.accept(created());client.accept(delta('Before'));
 client.setConnected(false);client.accept(delta('After missing chunks'));
 assert.equal(client.getSnapshot().drafts.at(-1).content,'Before');
 assert.equal(client.getSnapshot().incomplete,true);
 client.reconcile(stored(),client.checkpoint());
 assert.equal(client.getSnapshot().incomplete,true);
 client.accept(delta('',{snapshot:finalSnapshot}));
 assert.equal(client.getSnapshot().incomplete,false);
 assert.equal(client.getSnapshot().drafts.at(-1).content,'Corrected');
});
test('a paged stopped run replaces active state even when only its original user entry was saved',()=>{
 const client=createNarrativeController({sessionId:'s',request:assert.fail,getSession:assert.fail});
 client.reconcile(stored(),client.checkpoint());
 assert.equal(client.getSnapshot().activeRunId,'r');
 client.reconcile(stored('stopped'),client.checkpoint());
 assert.equal(client.getSnapshot().run.status,'stopped');
 assert.equal(client.getSnapshot().activeRunId,null);
});
test('a page fetched before a new live event cannot overwrite that event during recovery',async()=>{
 const client=createNarrativeController({sessionId:'s',getSession:async()=>({tipEntryId:null}),request:assert.fail});
 const checkpoint=client.checkpoint();
 client.accept(created('new'));client.accept(delta('New text',{},'new'));
 client.reconcile(stored('completed',true,'old'),checkpoint);
 assert.equal(client.getSnapshot().run.runId,'new');
 assert.equal(client.getSnapshot().drafts.at(-1).content,'New text');
});
test('uncertain submission failures are surfaced and never resubmitted automatically',async()=>{
 let posts=0;
 const client=createNarrativeController({sessionId:'s',getSession:async()=>({tipEntryId:'tip'}),request:async()=>{posts++;throw Error('network');}});
 await assert.rejects(client.send('Input'),/network/);
 assert.equal(posts,1);assert.equal(client.getSnapshot().sending,false);
 assert.equal(client.getSnapshot().error,'network');
});
test('stop only requests cancellation and late stop responses cannot revive a terminal run',async()=>{
 const stop=deferred();
 const client=createNarrativeController({sessionId:'s',getSession:async()=>({tipEntryId:null}),
 request:async(path,init)=>{assert.equal(init.method,'POST');return stop.promise;}});
 client.accept(created());const stopping=client.stop();assert.equal(client.getSnapshot().stopping,true);
 client.accept({event:'run.stopped',data:{...fields(),savedMessageIds:['r-u'],tipEntryId:'r-u',stop_reason:'cancelled'}});
 stop.resolve({runId:'r',stopping:true});await stopping;await nextTurn();
 assert.equal(client.getSnapshot().activeRunId,null);assert.equal(client.getSnapshot().stopping,false);
 assert.equal(client.getSnapshot().run.status,'stopped');
});
