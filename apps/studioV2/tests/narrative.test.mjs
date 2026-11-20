import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {createNarrativeController,appendMessageDelta} from '../src/features/narrative/controller.ts';
import {createHistoryController} from '../src/features/history/controller.ts';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const fields=(runId='r')=>({sessionId:'s',runId,provider:'test',model:'model',timestamp:10});
const created=(runId='r')=>({event:'run.created',data:{...fields(runId),messages:[{id:runId+'-u',role:'user',content:'Input',timestamp:1}]}});
const delta=(content,extra={},runId='r')=>({event:'run.delta',data:{...fields(runId),messageId:runId+'-a',messages:[{role:'assistant',delta:{content},...extra}]}});
const completed=(runId='r')=>({event:'run.completed',data:{...fields(runId),savedMessageIds:[runId+'-u',runId+'-a'],tipEntryId:runId+'-a'}});
const entry=(id,role,seq,runId='r')=>({id,sessionId:'s',parentId:null,runId,seq,type:'message',role,timestamp:seq,payload:{message:{role,content:role==='user'?'Input':'Saved'}},state:null,extData:{},metrics:null,createdAt:seq,updatedAt:seq});
const stored=(status='running',assistant=false,runId='r')=>({runId,status,firstSeq:1,lastSeq:assistant?2:1,entries:[entry(runId+'-u','user',1,runId),...(assistant?[entry(runId+'-a','assistant',2,runId)]:[])],...(status==='stopped'?{stopReason:'provider_error'}:{})});
const page=(items=[],activeRunId=null)=>({items,hasMore:false,nextCursor:null,nextAfterSeq:items.at(-1)?.lastSeq??null,activeRunId});
const finalSnapshot={role:'assistant',content:'Corrected',reasoning_content:'',tool_calls:[]};

test('POST uses the actual compaction tip; an entire lifecycle before 202 never restarts the completed run',async()=>{
 const post=deferred(),calls=[],saved=[];
 let server=stored();
 const client=createNarrativeController({sessionId:'s',getSession:async()=>({tipEntryId:'summary-tip'}),
  request:async(path,init)=>{calls.push({path,init});return init?.method==='POST'?post.promise:{item:structuredClone(server)};},
  onRunSaved:run=>saved.push(run),
 });
 const sending=client.send('  Original input  ');await nextTurn();
 assert.deepEqual(JSON.parse(calls[0].init.body),{input:{text:'  Original input  '},expectedTipEntryId:'summary-tip'});
 client.accept(created());client.accept(delta('Draft'));
 await assert.rejects(client.send('Duplicate'),/仍在生成/);
 client.accept(delta('',{snapshot:finalSnapshot,finish_reason:'stop'}));
 assert.equal(client.getSnapshot().activeRunId,'r');
 assert.equal(client.getSnapshot().drafts[0].content,'Corrected');
 assert.equal(client.getSnapshot().drafts[0].saved,false);
 server=stored('completed',true);client.accept(completed());await nextTurn();
 post.resolve({runId:'r',userEntryId:'r-u',assistantEntryId:'r-a'});await sending;
 assert.equal(client.getSnapshot().run.status,'completed');
 assert.equal(client.getSnapshot().activeRunId,null);
 assert.deepEqual(client.getSnapshot().drafts,[]);
 assert.equal(calls.filter(call=>call.init?.method==='POST').length,1);
 assert.ok(saved.some(run=>run.status==='completed'));
});
test('a terminal query does not reuse a stale created query and persisted history owns the handoff',async()=>{
 const oldRead=deferred();let reads=0;
 const history=createHistoryController({sessionId:'s',request:async()=>page()});
 const client=createNarrativeController({sessionId:'s',getSession:async()=>({tipEntryId:null}),
  request:async()=>++reads===1?oldRead.promise:{item:stored('completed',true)},
  onRunSaved:run=>history.ingestRun(run),
 });
 client.accept(created());client.accept(delta('Draft'));client.accept(completed());await nextTurn();
 assert.equal(reads,2);assert.equal(client.getSnapshot().drafts.length,0);
 oldRead.resolve({item:stored()});await nextTurn();
 assert.equal(client.getSnapshot().run.status,'completed');
 assert.equal(history.getSnapshot().runs[0].status,'completed');
 assert.deepEqual(history.getSnapshot().messages.map(message=>message.id),['r-u','r-a']);
});
test('deltas append fields and tool arguments while final snapshots replace every public field',()=>{
 const result=appendMessageDelta({role:'assistant',content:'A',reasoning_content:'Think',tool_calls:[]},{
  content:'B',reasoning_content:' more',tool_calls:[{index:2,id:'tool',function:{name:'lookup',arguments:'{"q":'}}],
 });
 const next=appendMessageDelta(result,{tool_calls:[{index:2,function:{arguments:'1}'}}]});
 assert.equal(next.content,'AB');assert.equal(next.reasoning_content,'Think more');
 assert.deepEqual(next.tool_calls,[{index:2,id:'tool',type:'function',function:{name:'lookup',arguments:'{"q":1}'}}]);
 const client=createNarrativeController({sessionId:'s',getSession:async()=>({tipEntryId:null}),request:async()=>({item:stored()})});
 client.accept(created());client.accept(delta('Old',{delta:{content:'Old',reasoning_content:'Reason',tool_calls:[{index:0,id:'x',function:{name:'x',arguments:'{}'}}]}}));
 client.accept(delta('',{snapshot:finalSnapshot}));
 assert.deepEqual(client.getSnapshot().drafts[0].tool_calls,[]);
 assert.equal(client.getSnapshot().drafts[0].reasoning_content,'');
 assert.equal(client.getSnapshot().drafts[0].content,'Corrected');
 client.dispose();
});
test('lost-stream deltas are not fabricated into a continuous message, but the final snapshot repairs it',async()=>{
 const client=createNarrativeController({sessionId:'s',getSession:async()=>({tipEntryId:null}),request:async()=>({item:stored()})});
 client.accept(created());client.accept(delta('Before'));
 client.setConnected(false);client.accept(delta('After missing chunks'));
 assert.equal(client.getSnapshot().drafts[0].content,'Before');
 assert.equal(client.getSnapshot().incomplete,true);
 await client.recover({page:page([stored()],'r'),knownActiveRunId:'r'});
 assert.equal(client.getSnapshot().incomplete,true);
 client.accept(delta('',{snapshot:finalSnapshot}));
 assert.equal(client.getSnapshot().incomplete,false);
 assert.equal(client.getSnapshot().drafts[0].content,'Corrected');
});
test('reconnect refreshes a known active run even with an empty afterSeq page and no new assistant entry',async()=>{
 let outcome=stored();const calls=[],saved=[];
 const client=createNarrativeController({sessionId:'s',getSession:async()=>({tipEntryId:null}),
  request:async(path,init)=>{calls.push({path,init});return {item:outcome};},onRunSaved:run=>saved.push(run),
 });
 await client.recover({page:page([stored()],'r')});
 assert.equal(client.getSnapshot().activeRunId,'r');
 outcome=stored('stopped');
 await client.recover({page:page(),knownActiveRunId:'r'});
 assert.equal(calls.at(-1).path,'v1/sessions/s/narrative/runs/r');
 assert.equal(client.getSnapshot().run.status,'stopped');
 assert.equal(client.getSnapshot().activeRunId,null);
 assert.equal(saved.at(-1).entries.length,1);
 assert.equal(calls.filter(call=>call.init?.method==='POST').length,0);
});
test('a page fetched before a new live event cannot overwrite that event during recovery',async()=>{
 const client=createNarrativeController({sessionId:'s',getSession:async()=>({tipEntryId:null}),request:async path=>({item:stored('running',false,path.endsWith('/new')?'new':'old')})});
 const checkpoint=client.checkpoint();
 client.accept(created('new'));client.accept(delta('New text',{},'new'));
 await client.recover({page:page([stored('completed',true,'old')]),checkpoint});
 assert.equal(client.getSnapshot().run.runId,'new');
 assert.equal(client.getSnapshot().drafts[0].content,'New text');
});
test('uncertain submission failures are surfaced and never resubmitted automatically',async()=>{
 let posts=0;
 const client=createNarrativeController({sessionId:'s',getSession:async()=>({tipEntryId:'tip'}),request:async()=>{posts++;throw Error('network');}});
 await assert.rejects(client.send('Input'),/network/);
 assert.equal(posts,1);assert.equal(client.getSnapshot().sending,false);
 assert.equal(client.getSnapshot().error,'network');
});
test('stop only requests cancellation and late stop responses cannot revive a terminal run',async()=>{
 const stop=deferred();let server=stored();
 const client=createNarrativeController({sessionId:'s',getSession:async()=>({tipEntryId:null}),
 request:async(path,init)=>init?.method==='POST'?stop.promise:{item:server}});
 client.accept(created());const stopping=client.stop();assert.equal(client.getSnapshot().stopping,true);
 server=stored('stopped');client.accept({event:'run.stopped',data:{...fields(),savedMessageIds:['r-u'],tipEntryId:'r-u',stop_reason:'cancelled'}});
 stop.resolve({runId:'r',stopping:true});await stopping;await nextTurn();
 assert.equal(client.getSnapshot().activeRunId,null);assert.equal(client.getSnapshot().stopping,false);
 assert.equal(client.getSnapshot().run.status,'stopped');
});
