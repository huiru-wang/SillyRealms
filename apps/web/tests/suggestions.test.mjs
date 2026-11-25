import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSuggestionsController} from '../src/features/suggestions/controller.ts';
const fields = (runId='r') => ({sessionId:'s',runId,assistantEntryId:runId+'-a',provider:null,model:null,timestamp:1});
const run = (runId='r',status='completed',items=['继续观察']) => ({
 runId,status,firstSeq:1,lastSeq:2,entries:[{id:'a',runId,seq:2,type:'message',role:'assistant',
 extData:{output:{actionSuggestions:{status:'partial_success',items}}}}],
});
test('completed partial results restore, a new run clears, and stale HTTP cannot restore previous suggestions',()=>{
 const client=createSuggestionsController('s'), checkpoint=client.checkpoint();
 assert.equal(client.restore(run(),checkpoint),true);
 assert.deepEqual(client.getSnapshot().suggestions.items,['继续观察']);
 const stale=client.checkpoint();
 client.accept({event:'run.created',data:{...fields('next'),messages:[{id:'u2',role:'user',content:'Next',timestamp:2}]}});
 assert.equal(client.getSnapshot().suggestions,null);
 assert.equal(client.restore(run(),stale),false);
 client.accept({event:'action_suggestions.created',data:{...fields('r'),messageId:'old',items:['过期']}});
 assert.equal(client.getSnapshot().suggestions,null);
 client.accept({event:'action_suggestions.created',data:{...fields('next'),messageId:'next-a',items:['新建议']}});
 assert.deepEqual(client.getSnapshot().suggestions,{runId:'next',messageId:'next-a',items:['新建议']});
});
test('latest empty, stopped, running and unknown results never fall back to earlier suggestions',()=>{
 for(const status of ['stopped','running','unknown']){
  const client=createSuggestionsController('s');
  client.restore(run(),client.checkpoint());
  client.restore(run('new',status),client.checkpoint());
  assert.equal(client.getSnapshot().suggestions,null);
  assert.equal(client.getSnapshot().currentRunId,'new');
 }
 const client=createSuggestionsController('s');
 client.restore(run('empty','completed',[]),client.checkpoint());
 assert.equal(client.getSnapshot().suggestions,null);
});
test('suggestions replace as a set and consumer failures stay isolated',()=>{
 const client=createSuggestionsController('s');let notifications=0;
 client.subscribe(()=>{throw Error('view');});client.subscribe(()=>notifications++);
 client.accept({event:'action_suggestions.created',data:{...fields(),messageId:'a',items:['第一']}});
 client.accept({event:'action_suggestions.created',data:{...fields(),messageId:'a',items:['第二','第三']}});
 assert.deepEqual(client.getSnapshot().suggestions.items,['第二','第三']);
 assert.equal(notifications,2);
 client.dispose();client.clear();assert.equal(notifications,2);
});

test('regeneration clears deleted suggestions and rejects late results from the old assistant',()=>{
 const suggestions=createSuggestionsController('s');
 suggestions.begin('r','new-a');
 suggestions.accept({event:'action_suggestions.created',data:{sessionId:'s',runId:'r',messageId:'old-a',items:['Old']}});
 assert.equal(suggestions.getSnapshot().suggestions,null);
 suggestions.accept({event:'action_suggestions.created',data:{sessionId:'s',runId:'r',messageId:'new-a',items:['New']}});
 assert.deepEqual(suggestions.getSnapshot().suggestions.items,['New']);
 suggestions.accept({event:'message.deleted',data:{sessionId:'s',runId:'r',assistantEntryId:'next-a',messageId:'new-a',tipEntryId:'u'}});
 assert.equal(suggestions.getSnapshot().suggestions,null);
});


test('restore considers only the last ordinary message, ignoring hidden entries without looking back to an assistant',()=>{
 const client=createSuggestionsController('s'), saved=run();
 const summary={...saved.entries[0],id:'summary',seq:3,type:'compaction',role:null};
 client.restore({...saved,entries:[...saved.entries,summary]},client.checkpoint());
 assert.deepEqual(client.getSnapshot().suggestions.items,['继续观察']);
 const user={...saved.entries[0],id:'u2',seq:4,role:'user',extData:{}};
 client.restore({...saved,lastSeq:5,entries:[...saved.entries,user,{...summary,seq:5}]},client.checkpoint());
 assert.equal(client.getSnapshot().suggestions,null);
 const emptyAssistant={...saved.entries[0],id:'a2',seq:6,extData:{}};
 client.restore({...saved,lastSeq:6,entries:[...saved.entries,emptyAssistant]},client.checkpoint());
 assert.equal(client.getSnapshot().suggestions,null);
 client.restore({...saved,entries:[summary]},client.checkpoint());
 assert.equal(client.getSnapshot().suggestions,null);
});

test('a repeated execution receipt cannot clear suggestions that have already arrived',()=>{
 const client=createSuggestionsController('s');
 client.begin('r','r-a');
 client.accept({event:'action_suggestions.created',data:{sessionId:'s',runId:'r',messageId:'r-a',items:['Current']}});
 const revision=client.checkpoint();
 client.begin('r','r-a');
 client.accept({event:'run.created',data:{...fields(),messages:[]}});
 assert.deepEqual(client.getSnapshot().suggestions.items,['Current']);
 assert.equal(client.checkpoint(),revision);
 client.begin('r','next-a');
 assert.equal(client.getSnapshot().suggestions,null);
 client.accept({event:'action_suggestions.created',data:{sessionId:'s',runId:'r',messageId:'r-a',items:['Old']}});
 assert.equal(client.getSnapshot().suggestions,null);
});

test('recovery never replaces a newer live result and empty results replace the whole set',()=>{
 const client=createSuggestionsController('s');
 client.begin('r','r-a');
 const checkpoint=client.checkpoint();
 client.accept({event:'action_suggestions.created',data:{sessionId:'s',runId:'r',messageId:'r-a',items:['Live']}});
 assert.equal(client.restore(run(),checkpoint),false);
 assert.deepEqual(client.getSnapshot().suggestions.items,['Live']);
 client.accept({event:'action_suggestions.created',data:{sessionId:'s',runId:'r',messageId:'r-a',items:[]}});
 assert.equal(client.getSnapshot().suggestions,null);
});

test('a first live or restored result also identifies the execution for duplicate confirmation',()=>{
 for(const restore of [false,true]){
  const client=createSuggestionsController('s');
  if(restore)client.restore(run(),client.checkpoint());
  else client.accept({event:'action_suggestions.created',data:{sessionId:'s',runId:'r',messageId:'a',items:['Current']}});
  const current=client.getSnapshot();
  client.begin('r','a');
  assert.equal(client.getSnapshot(),current);
  client.accept({event:'action_suggestions.created',data:{sessionId:'s',runId:'r',messageId:'old-a',items:['Old']}});
  assert.equal(client.getSnapshot(),current);
 }
});
