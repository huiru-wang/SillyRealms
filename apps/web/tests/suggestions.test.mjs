import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSuggestionsController} from '../src/features/suggestions/controller.ts';
const fields = (runId='r') => ({sessionId:'s',runId,provider:null,model:null,timestamp:1});
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
