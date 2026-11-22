import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {createSessionWorkspace} from '../src/features/sessions/workspace.ts';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const entry=(id,seq,runId,role='assistant')=>({id,sessionId:'s',parentId:null,runId,seq,type:'message',role,timestamp:seq,
 payload:{message:{role,content:role==='user'?'Go':'Saved answer'}},state:null,extData:{},metrics:null,createdAt:seq,updatedAt:seq});
const run=(id,entries,status='completed')=>({runId:id,assistantEntryId:id+'-a',entries,status,firstSeq:entries[0].seq,lastSeq:entries.at(-1).seq,
 ...(status==='completed'?{finishedAt:10}:{}),...(status==='stopped'?{finishedAt:10,stopReason:'summary_capacity_exceeded'}:{})});
const fields=(runId='r')=>({sessionId:'s',runId,assistantEntryId:runId+'-a',provider:'test',model:'model',timestamp:10});
function eventPort(){
 const events=new Set(),connections=new Set();let generation=0,closed=false;
 return {
  subscribe(namespace,listener){events.add(listener);return()=>events.delete(listener);},
  subscribeConnection(listener){connections.add(listener);listener({sessionId:'s',connected:false,status:'idle',generation});return()=>connections.delete(listener);},
  connect(){for(const listener of connections)listener({sessionId:'s',connected:true,status:'connected',generation:++generation});},
  emit(event){for(const listener of events)listener(structuredClone(event));},
  disconnect(){for(const listener of connections)listener({sessionId:'s',connected:false,status:'reconnecting',generation});},
  dispose(){closed=true;events.clear();connections.clear();},
  get closed(){return closed;},
 };
}
function setup(initialActive=false){
 const channel=eventPort(),calls=[],opening=run('opening',[entry('opening-a',1,'opening')]);
 const server={runs:[opening],active:null,tip:'opening-a',coins:10,onRequest:null,onSession:null};
 if(initialActive){server.runs.push(run('r',[entry('r-u',2,'r','user')],'running'));server.active='r';server.tip='r-u';}
 const request=async(path,init={})=>{
  calls.push({path,init});
  if(server.onRequest){const special=server.onRequest(path,init);if(special!==undefined)return special;}
  if(path.startsWith('v1/state/global/'))return {item:{weather:'sun'}};
  if(path.startsWith('v1/state/session/'))return {item:{visited:true}};
  if(path.startsWith('v1/state/message/'))return {item:[{key:'coins',value:server.coins}]};
  if(path.split('?')[0]==='v1/sessions/s/narrative/runs'){
   const afterSeq=new URL('http://local/'+path).searchParams.get('afterSeq');
   const items=server.runs.filter(run=>afterSeq===null||run.lastSeq>Number(afterSeq));
   return {items:structuredClone(items),hasMore:false,nextCursor:null,nextAfterSeq:items.length?Math.max(...items.map(run=>run.lastSeq)):null,activeRunId:server.active};
  }
  throw Error('Unexpected request '+path);
 };
 const workspace=createSessionWorkspace('s',{
  request,channel,
  readSession:async()=>server.onSession?server.onSession():({id:'s',worldId:'w',worldName:'World',cover:null,userCharacterId:'player',presetId:'preset',apiModelConfigId:'model',title:'Session',tipEntryId:server.tip,updatedAt:1}),
  readRuntimeConfig:async()=>({stage:{origin:'http://stage.test',entryPath:'/frame.html'},debug:false}),
  loadStageWorld:async()=>({world:{id:'w'},modules:{},main:null,rules:[],state:{},assetBaseUrl:null}),
 });
 return {workspace,server,channel,calls};
}
test('composition initially restores the active run and persisted user without inventing lost assistant fragments',async()=>{
 const {workspace,calls,channel}=setup(true);await workspace.start();
 const view=workspace.getSnapshot();
 assert.equal(view.loading,false);assert.equal(view.stage.connected,true);
 assert.equal(view.stage.activeRunId,'r');assert.equal(view.stage.streamIncomplete,true);
 assert.deepEqual(view.stage.runs.at(-1).messages.map(message=>message.id),['r-u']);
 assert.equal(view.stage.state.message.coins,10);
 assert.equal(calls.some(call=>call.init.method==='POST'),false);
 workspace.dispose();assert.equal(channel.closed,true);
 assert.equal(calls.some(call=>call.path.endsWith('/stop')),false);
});
test('terminal composition uses the true compaction tip and rereads state after settlement',async()=>{
 const {workspace,server,channel,calls}=setup(true);await workspace.start();calls.length=0;
 const summary={...entry('summary',3,'r'),type:'compaction',role:null,payload:{summary:'Summary'}};
 server.runs[1]=run('r',[entry('r-u',2,'r','user'),summary],'stopped');
 server.active=null;server.tip='summary';server.coins=8;
 channel.emit({event:'run.stopped',data:{...fields(),savedMessageIds:['r-u'],tipEntryId:'summary',stop_reason:'summary_capacity_exceeded'}});
 await nextTurn();
 assert.equal(workspace.getSnapshot().session.tipEntryId,'summary');
 assert.ok(calls.some(call=>call.path==='v1/state/message/s/summary'));
 assert.equal(workspace.getSnapshot().stage.state.message.coins,8);
 assert.deepEqual(workspace.getSnapshot().stage.runs.at(-1).messages.map(message=>message.id),['r-u']);
 assert.equal(workspace.getSnapshot().stage.activeRunId,null);
 workspace.dispose();
});
test('events before POST and cursor reconciliation produce one saved answer with the current suggestions',async()=>{
 const {workspace,server,channel,calls}=setup();await workspace.start();
 const post=deferred();
 server.onRequest=(path,init)=>{
  if(init.method==='POST'&&path==='v1/sessions/s/narrative/runs')return post.promise;
 };
 const sending=workspace.command('narrative.send',{text:'Go'});await nextTurn();
 server.runs.push(run('r',[entry('r-u',2,'r','user')],'running'));server.active='r';server.tip='r-u';
 channel.emit({event:'run.created',data:{...fields(),tipEntryId:'r-u',deletedMessageIds:[],messages:[{id:'r-u',role:'user',content:'Go',timestamp:2}]}});
 channel.emit({event:'run.delta',data:{...fields(),messageId:'r-a',messages:[{role:'assistant',delta:{content:'Draft'}}]}});
 channel.emit({event:'run.delta',data:{...fields(),messageId:'r-a',messages:[{role:'assistant',delta:{},snapshot:{role:'assistant',content:'Saved answer',reasoning_content:'',tool_calls:[]},finish_reason:'stop'}]}});
 const assistant=entry('r-a',3,'r');assistant.extData.output={actionSuggestions:{status:'success',items:['继续观察']}};
 server.runs[1]=run('r',[entry('r-u',2,'r','user'),assistant]);server.active=null;server.tip='r-a';server.coins=7;
 channel.emit({event:'action_suggestions.created',data:{sessionId:'s',runId:'r',messageId:'r-a',items:['继续观察']}});
 channel.emit({event:'run.completed',data:{...fields(),savedMessageIds:['r-u','r-a'],tipEntryId:'r-a'}});
 await nextTurn();
 post.resolve({runId:'r',userEntryId:'r-u',assistantEntryId:'r-a',tipEntryId:'r-u',deletedMessageIds:[],userMessage:{id:'r-u',role:'user',content:'Go',timestamp:2}});await sending;await nextTurn();
 const view=workspace.getSnapshot();
 assert.equal(view.stage.activeRunId,null);assert.equal(view.stage.runs.at(-1).status,'completed');
 assert.deepEqual(view.stage.runs.at(-1).messages.map(message=>[message.id,message.saved]),[['r-u',true],['r-a',true]]);
 assert.equal(view.session.tipEntryId,'r-a');assert.equal(view.stage.state.message.coins,7);
 assert.deepEqual(view.stage.suggestions.items,['继续观察']);
 assert.equal(calls.filter(call=>call.init.method==='POST'&&call.path==='v1/sessions/s/narrative/runs').length,1);
 workspace.dispose();
});
test('HTTP acceptance reaches the stage before SSE and history without duplicating the user',async t=>{
 const {workspace,server,channel}=setup();t.after(()=>workspace.dispose());await workspace.start();
 const userMessage={id:'r-u',role:'user',content:'Go',timestamp:2};
 server.onRequest=(path,init)=>{
  if(init.method==='POST'&&path==='v1/sessions/s/narrative/runs'){
   server.runs.push(run('r',[entry('r-u',2,'r','user')],'running'));server.active='r';server.tip='r-u';
   return {runId:'r',userEntryId:'r-u',assistantEntryId:'r-a',userMessage};
  }
 };
 await workspace.command('narrative.send',{text:'Go'});
 const userIds=()=>workspace.getSnapshot().stage.runs.at(-1).messages.map(message=>message.id);
 assert.deepEqual(userIds(),['r-u']);
 channel.emit({event:'run.created',data:{...fields(),tipEntryId:'r-u',deletedMessageIds:[],messages:[userMessage]}});
 assert.deepEqual(userIds(),['r-u']);
 await workspace.refresh();
 assert.deepEqual(userIds(),['r-u']);
});
test('reconnecting after a user-only stop reconciles the running seq through one runs page',async t=>{
 const {workspace,server,channel,calls}=setup(true);
 t.after(()=>workspace.dispose());
 await workspace.start();
 channel.disconnect();calls.length=0;
 server.active=null;
 server.runs[1]=run('r',[entry('r-u',2,'r','user')],'stopped');
 channel.connect();await nextTurn();
 const stage=workspace.getSnapshot().stage;
 assert.equal(stage.activeRunId,null);
 assert.equal(stage.runs.at(-1).status,'stopped');
 assert.deepEqual(stage.runs.at(-1).messages.map(message=>message.id),['r-u']);
 assert.deepEqual(calls.map(call=>call.path).filter(path=>path.includes('/narrative/')),['v1/sessions/s/narrative/runs']);
});
test('closing an active composition only disposes transports and pending reads, never requests stop',async()=>{
 const {workspace,channel,calls}=setup(true);await workspace.start();
 const snapshot=workspace.getSnapshot();workspace.dispose();
 channel.emit({event:'run.completed',data:{...fields(),savedMessageIds:['r-u'],tipEntryId:'r-u'}});
 await nextTurn();assert.equal(workspace.getSnapshot(),snapshot);
 assert.equal(calls.some(call=>call.path.endsWith('/stop')),false);
});

test('changing the model refreshes usage while other session settings keep the current request snapshot',async t=>{
 const {workspace}=setup();t.after(()=>workspace.dispose());await workspace.start();
 const initial=workspace.getSnapshot(),revisions=[];
 const unsubscribe=workspace.subscribe(()=>revisions.push(workspace.getSnapshot().usageRevision));t.after(unsubscribe);
 workspace.updateSession({...initial.session,title:'Renamed session',presetId:'another-preset'});
 assert.equal(workspace.getSnapshot().usageRevision,initial.usageRevision);
 workspace.updateSession({...workspace.getSnapshot().session,apiModelConfigId:'another-model'});
 assert.equal(workspace.getSnapshot().session.apiModelConfigId,'another-model');
 assert.equal(workspace.getSnapshot().usageRevision,initial.usageRevision+1);
 workspace.updateSession({...workspace.getSnapshot().session,title:'Another title'});
 assert.deepEqual(revisions,[initial.usageRevision,initial.usageRevision+1,initial.usageRevision+1]);
});

test('regeneration deletes the old projection before streaming, retains summary tip and clears suggestions',async()=>{
 const {workspace,server,channel}=setup(true);server.active=null;server.tip='r-a';
 server.runs[1]=run('r',[entry('r-u',2,'r','user'),entry('r-a',3,'r')]);
 server.runs[1].entries[1].extData.output={actionSuggestions:{status:'success',items:['Old action']}};
 await workspace.start();assert.equal(workspace.getSnapshot().stage.suggestions.messageId,'r-a');
 channel.emit({event:'message.deleted',data:{sessionId:'s',runId:'r',assistantEntryId:'new-a',messageId:'r-a',tipEntryId:'summary'}});
 assert.deepEqual(workspace.getSnapshot().stage.runs.at(-1).messages.map(message=>message.id),['r-u']);
 assert.equal(workspace.getSnapshot().stage.activeAssistantEntryId,'new-a');
 channel.emit({event:'run.created',data:{...fields(),assistantEntryId:'new-a',messages:[{id:'r-u',role:'user',content:'Go',timestamp:2}],tipEntryId:'summary',deletedMessageIds:['r-a']}});
 assert.equal(workspace.getSnapshot().session.tipEntryId,'summary');
 assert.deepEqual(workspace.getSnapshot().stage.runs.at(-1).messages.map(message=>message.id),['r-u']);
 assert.equal(workspace.getSnapshot().stage.suggestions,null);
 channel.emit({event:'run.completed',data:{...fields(),savedMessageIds:['r-u','r-a'],tipEntryId:'r-a'}});
 assert.equal(workspace.getSnapshot().stage.activeAssistantEntryId,'new-a');
 channel.emit({event:'run.delta',data:{...fields(),assistantEntryId:'new-a',messageId:'new-a',messages:[{role:'assistant',delta:{content:'New'}}]}});
 assert.deepEqual(workspace.getSnapshot().stage.runs.at(-1).messages.map(message=>message.id),['r-u','new-a']);
 workspace.dispose();
});

test('reconnect replaces a deleted assistant even when lastSeq shrank and the regeneration event was lost',async()=>{
 const {workspace,server,channel}=setup(true);server.active=null;server.tip='r-a';
 server.runs[1]=run('r',[entry('r-u',2,'r','user'),entry('r-a',3,'r')]);
 await workspace.start();channel.disconnect();
 server.runs[1]={...run('r',[entry('r-u',2,'r','user')],'stopped'),assistantEntryId:'new-a'};server.tip='r-u';
 channel.connect();await nextTurn();
 assert.deepEqual(workspace.getSnapshot().stage.runs.at(-1).messages.map(message=>message.id),['r-u']);
 assert.equal(workspace.getSnapshot().stage.activeRunId,null);assert.equal(workspace.getSnapshot().session.tipEntryId,'r-u');
 workspace.dispose();
});
