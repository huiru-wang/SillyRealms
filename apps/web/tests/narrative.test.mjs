import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {createNarrativeController,appendMessageDelta} from '../src/features/narrative/controller.ts';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const fields=(runId='r')=>({sessionId:'s',runId,assistantEntryId:runId+'-a',provider:'test',model:'model',timestamp:10});
const created=(runId='r')=>({event:'run.created',data:{...fields(runId),tipEntryId:runId+'-u',deletedMessageIds:[],messages:[{id:runId+'-u',role:'user',content:'Input',timestamp:1}]}});
const accepted=(runId='r')=>({runId,userEntryId:runId+'-u',assistantEntryId:runId+'-a',tipEntryId:runId+'-u',deletedMessageIds:[],userMessage:created(runId).data.messages[0]});
const delta=(content,extra={},runId='r')=>({event:'run.delta',data:{...fields(runId),messageId:runId+'-a',messages:[{role:'assistant',delta:{content},...extra}]}});
const completed=(runId='r')=>({event:'run.completed',data:{...fields(runId),savedMessageIds:[runId+'-u',runId+'-a'],tipEntryId:runId+'-a'}});
const entry=(id,role,seq,runId='r')=>({id,sessionId:'s',parentId:null,runId,seq,type:'message',role,timestamp:seq,payload:{message:{role,content:role==='user'?'Input':'Saved'}},state:null,extData:{},metrics:null,createdAt:seq,updatedAt:seq});
const stored=(status='running',assistant=false,runId='r')=>({runId,assistantEntryId:runId+'-a',status,firstSeq:1,lastSeq:assistant?2:1,entries:[entry(runId+'-u','user',1,runId),...(assistant?[entry(runId+'-a','assistant',2,runId)]:[])],...(status==='stopped'?{stopReason:'provider_error'}:{})});
const finalSnapshot={role:'assistant',content:'Corrected',reasoning_content:'',tool_calls:[]};

test('HTTP acceptance displays the saved user immediately and run.created only confirms it',async()=>{
 const tips=[];
 const client=createNarrativeController({sessionId:'s',getSession:async()=>({tipEntryId:null}),
  request:async()=>accepted(),onTipChanged:tip=>tips.push(tip)});
 await client.send('Input');
 assert.deepEqual(client.getSnapshot().run.messages,[{...accepted().userMessage,runId:'r',saved:true}]);
 client.accept(created());client.accept(delta('Answer'));client.accept(created());
 assert.equal(client.getSnapshot().run.phase,'generating');
 client.accept({event:'run.summarized',data:{...fields(),entryId:'summary'}});
 client.accept(created());
 assert.deepEqual(client.getSnapshot().drafts.map(message=>[message.id,message.content]),[['r-u','Input'],['r-a','Answer']]);
 assert.deepEqual(tips,['r-u','summary']);
 client.dispose();
});
test('a late HTTP acceptance preserves the newer streamed answer and generating phase',async()=>{
 const post=deferred();
 const client=createNarrativeController({sessionId:'s',getSession:async()=>({tipEntryId:null}),request:async()=>post.promise});
 const sending=client.send('Input');await nextTurn();
 client.accept(created());client.accept(delta('Answer'));
 post.resolve(accepted());await sending;
 assert.equal(client.getSnapshot().run.phase,'generating');
 assert.deepEqual(client.getSnapshot().drafts.map(message=>[message.id,message.content]),[['r-u','Input'],['r-a','Answer']]);
 client.dispose();
});
test('HTTP acceptance fills a missing user after stream progress without resetting the phase',async()=>{
 const post=deferred(),tips=[];
 const client=createNarrativeController({sessionId:'s',getSession:async()=>({tipEntryId:null}),
  request:async()=>post.promise,onTipChanged:tip=>tips.push(tip)});
 const sending=client.send('Input');await nextTurn();
 client.accept({event:'run.summarizing',data:fields()});
 post.resolve(accepted());await sending;
 assert.equal(client.getSnapshot().run.phase,'summarizing');
 assert.deepEqual(client.getSnapshot().drafts.map(message=>message.id),['r-u']);
 assert.deepEqual(tips,[]);
 client.dispose();
});
test('run.created compensates for an HTTP timeout with the saved user message',async()=>{
 const client=createNarrativeController({sessionId:'s',getSession:async()=>({tipEntryId:null}),
  request:async()=>{throw Error('timeout');}});
 await assert.rejects(client.send('Input'),/timeout/);
 assert.deepEqual(client.getSnapshot().drafts,[]);
 client.accept(created());
 assert.deepEqual(client.getSnapshot().drafts,[{...accepted().userMessage,runId:'r',saved:true}]);
 assert.equal(client.getSnapshot().activeRunId,'r');
 assert.equal(client.getSnapshot().error,null);
 client.dispose();
});

test('POST uses the actual compaction tip; an entire lifecycle before 202 never restarts the completed run',async()=>{
 const post=deferred(),calls=[];
 const client=createNarrativeController({sessionId:'s',getSession:async()=>({tipEntryId:'summary-tip'}),
  request:async(path,init)=>{calls.push({path,init});assert.equal(init.method,'POST');return post.promise;},
 });
 const sending=client.send('  Original input  ');await nextTurn();
 assert.deepEqual(JSON.parse(calls[0].init.body),{input:{text:'  Original input  '},expectedTipEntryId:'summary-tip'});
 client.accept(created());client.accept(delta('Draft'));
 await assert.rejects(client.send('Duplicate'),{message:'sessions:alreadyRunning'});
 client.accept(delta('',{snapshot:finalSnapshot,finish_reason:'stop'}));
 assert.equal(client.getSnapshot().activeRunId,'r');
 assert.equal(client.getSnapshot().drafts.at(-1).content,'Corrected');
 assert.equal(client.getSnapshot().drafts.at(-1).saved,false);
 client.accept(completed());client.reconcile(stored('completed',true),client.checkpoint());
 post.resolve(accepted());await sending;
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

test('regeneration uses a new execution in the same round and ignores old terminal/stop traffic',async()=>{
 const post=deferred(),receipts=[],calls=[];
 const client=createNarrativeController({sessionId:'s',getSession:async()=>({tipEntryId:'r-a'}),onAccepted:value=>receipts.push(value),request:async(path,init)=>{calls.push({path,body:JSON.parse(init.body)});return post.promise;}});
 client.accept(created());client.accept(completed());
 const pending=client.regenerate({userEntryId:'r-u',assistantEntryId:'r-a'});await nextTurn();
 assert.deepEqual(calls[0],{path:'v1/sessions/s/narrative/runs/regenerate',body:{userEntryId:'r-u',assistantEntryId:'r-a',expectedTipEntryId:'r-a'}});
 const receipt={...accepted(),assistantEntryId:'new-a',deletedMessageIds:['r-a'],tipEntryId:'summary'};
 client.accept({event:'run.created',data:{...created().data,assistantEntryId:'new-a',tipEntryId:'summary',deletedMessageIds:['r-a']}});
 client.accept({event:'run.delta',data:{...delta('New').data,assistantEntryId:'new-a',messageId:'new-a'}});
 client.accept(completed());
 assert.equal(client.getSnapshot().run.assistantEntryId,'new-a');assert.equal(client.getSnapshot().run.status,'running');
 await assert.rejects(client.stop('r','r-a'),{message:'sessions:nothingToStop'});
 post.resolve(receipt);await pending;
 assert.equal(receipts.filter(item=>item.assistantEntryId==='new-a').length,1);
 assert.deepEqual(client.getSnapshot().drafts.map(item=>item.id),['r-u','new-a']);
 client.accept({event:'run.completed',data:{...completed().data,assistantEntryId:'new-a',savedMessageIds:['r-u','new-a'],tipEntryId:'new-a'}});
 assert.equal(client.getSnapshot().activeRunId,null);
});

test('completed regeneration before its HTTP response stays settled and never reapplies deletion',async()=>{
 const post=deferred(),receipts=[];
 const client=createNarrativeController({sessionId:'s',getSession:async()=>({tipEntryId:'r-a'}),onAccepted:value=>receipts.push(value),request:()=>post.promise});
 client.accept(created());client.accept(completed());
 const pending=client.regenerate({userEntryId:'r-u',assistantEntryId:'r-a'});await nextTurn();
 client.accept({event:'run.created',data:{...created().data,assistantEntryId:'new-a',deletedMessageIds:['r-a']}});
 client.accept({event:'run.completed',data:{...completed().data,assistantEntryId:'new-a',savedMessageIds:['r-u','new-a'],tipEntryId:'new-a'}});
 post.resolve({...accepted(),assistantEntryId:'new-a',deletedMessageIds:['r-a']});await pending;
 assert.equal(client.getSnapshot().run.status,'completed');assert.equal(client.getSnapshot().activeRunId,null);
 assert.equal(receipts.filter(item=>item.assistantEntryId==='new-a').length,1);
});

test('reconnect to a new execution of the same round drops old transient output and usage',()=>{
 const client=createNarrativeController({sessionId:'s',getSession:async()=>({tipEntryId:null}),request:assert.fail});
 client.accept(created());client.accept(delta('Old'));client.accept(completed());
 client.reconcile({...stored('running'),assistantEntryId:'new-a'},client.checkpoint());
 assert.deepEqual(client.getSnapshot().drafts,[]);assert.equal(client.getSnapshot().run.assistantEntryId,'new-a');
 assert.equal(client.getSnapshot().incomplete,true);assert.equal(client.getSnapshot().usage,undefined);
});


test('a late HTTP receipt for a completed execution cannot replace a newer accepted execution',async()=>{
 const post=deferred(),receipts=[];
 const client=createNarrativeController({sessionId:'s',getSession:async()=>({tipEntryId:null}),
  request:()=>post.promise,onAccepted:value=>receipts.push(value.assistantEntryId)});
 const sending=client.send('Input');await nextTurn();
 client.accept(created());client.accept(completed());
 client.accept(created('next'));client.accept(delta('New answer',{},'next'));
 post.resolve(accepted());await sending;
 assert.equal(client.getSnapshot().run.runId,'next');
 assert.equal(client.getSnapshot().activeRunId,'next');
 assert.deepEqual(client.getSnapshot().drafts.map(message=>message.id),['next-u','next-a']);
 assert.deepEqual(receipts,['r-a','next-a']);
 client.dispose();
});
