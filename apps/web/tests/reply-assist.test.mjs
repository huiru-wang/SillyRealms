import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ApiError} from '../src/api.ts';
import {createReplyAssistController} from '../src/features/reply-assist/controller.ts';

function harness(t){
  const view={drafts:[],errors:[],busy:[]}, calls=[], frames=new Map();
  let resolve, reject, frameId=0;
  t.mock.method(globalThis,'requestAnimationFrame',cb=>{frames.set(++frameId,cb);return frameId;});
  t.mock.method(globalThis,'cancelAnimationFrame',id=>frames.delete(id));
  const started=new Promise((yes,no)=>{resolve=yes;reject=no;});
  const controller=createReplyAssistController('s',{
    draft:v=>view.drafts.push(v),error:e=>view.errors.push(e),busy:b=>view.busy.push(b),
  },async(path,init)=>{calls.push({path,init});if(path.endsWith('/stop'))return {};return started;});
  const event=(kind,payload,overrides={})=>controller.accept({event:'reply_assist.'+kind,data:{
    sessionId:'s',requestId:JSON.parse(calls[0].init.body).requestId,...payload,...overrides,
  }});
  return {view,controller,started,calls,frames,resolve,reject,event};
}
// Node's test environment has no display refresh clock.
globalThis.requestAnimationFrame??=()=>0;
globalThis.cancelAnimationFrame??=()=>{};
test('renders matched chunks once per frame and replaces them with the final snapshot before late HTTP errors',async t=>{
  const h=harness(t),draft='原稿';
  const start=h.controller.start(draft);
  h.event('delta',{delta:{content:'foreign'}},{requestId:'other'});
  h.event('delta',{delta:{content:'foreign'}},{sessionId:'other'});
  h.event('delta',{delta:{content:'「先'}});
  h.event('delta',{delta:{content:'hello」'}});
  assert.equal(h.frames.size,1);h.frames.values().next().value();
  assert.deepEqual(h.view.drafts,['「先hello」']);
  h.event('completed',{snapshot:{content:'「先hello」行こう。'}});
  h.event('delta',{delta:{content:'late'}});h.reject(new Error('late timeout'));await start;
  assert.deepEqual(h.view.drafts,['「先hello」','「先hello」行こう。']);
  assert.deepEqual(h.view.busy,[true,false]);assert.deepEqual(h.view.errors,[]);assert.equal(h.calls.length,1);
});
test('reports a rejected launch once and keeps the original draft without stopping the narrative',async t=>{
  const h=harness(t),start=h.controller.start('original');
  await h.controller.start('duplicate');
  h.reject(new ApiError('RUN_ALREADY_ACTIVE','occupied',409));await start;
  assert.equal(h.calls.length,1);assert.equal(h.view.errors.length,1);
  assert.equal(h.view.errors[0].errorCode,'RUN_ALREADY_ACTIVE');assert.deepEqual(h.view.drafts,['original']);
});
test('disconnect flushes pending text and abandons the request even if acceptance arrives later',async t=>{
  const h=harness(t),start=h.controller.start('original');
  h.event('delta',{delta:{content:'部分'}});
  h.controller.interrupt(true);
  h.event('completed',{snapshot:{content:'late'}});
  h.resolve({});await start;
  assert.equal(h.frames.size,0);assert.deepEqual(h.view.drafts,['部分']);
  assert.deepEqual(h.view.errors,['sessions:assistDisconnected']);
  assert.ok(h.calls.slice(1).every(call=>call.path.endsWith('/stop')));
});
test('accepts a snapshot without deltas and preserves the original when stopped with no text',async t=>{
  const h=harness(t),start=h.controller.start('existing');
  h.event('stopped',{snapshot:{content:''},stop_reason:'cancelled'});
  h.resolve({});await start;
  assert.deepEqual(h.view.drafts,['existing']);assert.deepEqual(h.view.errors,[]);
});
