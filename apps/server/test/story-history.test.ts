import {expect,it} from 'vitest';
import {applyRunEvent,displayMessages,hasDeltaGap,mergeHistory,mergeInitial} from '../../../packages/sr-sdk/src/story-history.js';
import type {Run,RunEvent} from '../../../packages/sr-sdk/src/run-contract.js';

it('does not duplicate deltas already in the initial history and keeps terminal messages',()=>{
 const runs:Run[]=[{id:'r',status:'running',messages:[{id:'m',role:'assistant',text:'A'}]}];
 const events:RunEvent[]=[{event:'run.delta',data:{runId:'r',messageId:'m',text:'A'}},{event:'run.completed',data:{runId:'r',messages:[{id:'m',role:'assistant',text:'AB'}]}}];
 expect(mergeInitial(runs,events)[0]).toEqual({id:'r',status:'completed',phase:'finalized',messages:[{id:'m',role:'assistant',text:'AB'}]});
});
it('accepts a preflight failure without a created event',()=>{
 expect(applyRunEvent([],{event:'run.failed',data:{runId:'r',messages:[],errorCode:'INTERNAL_ERROR',errorMessage:'服务器内部错误'}})).toEqual([{id:'r',status:'failed',phase:'finalized',messages:[]}]);
});

it('merges consecutive assistant messages for display across streamed and completed runs',()=>{
 const original:Run[]=[{id:'r',status:'running',messages:[{id:'u',role:'user',text:'行动'},{id:'a',role:'assistant',text:'第一段'}]}];
 const streamed=applyRunEvent(original,{event:'run.delta',data:{runId:'r',messageId:'b',text:'第二段'}});
 const completed=applyRunEvent(streamed,{event:'run.completed',data:{runId:'r',messages:streamed[0]!.messages}});
 expect(displayMessages(streamed[0]!.messages)).toEqual([{id:'u',role:'user',text:'行动'},{id:'a',role:'assistant',text:'第一段\n\n第二段'}]);
 expect(displayMessages(completed[0]!.messages)).toEqual(displayMessages(streamed[0]!.messages));
 expect(completed[0]!.messages).toHaveLength(3);
 expect(displayMessages([{id:'a',role:'assistant',text:'甲'},{id:'u',role:'user',text:'乙'},{id:'b',role:'assistant',text:'丙'}])).toHaveLength(3);
});

it('keeps terminal results authoritative over late preparation, delta and created events',()=>{
  const done=applyRunEvent([],{event:'run.completed',data:{runId:'r',messages:[{id:'a',role:'assistant',text:'final'}],executionMode:'direct',phase:'finalized'}});
  expect(applyRunEvent(done,{event:'run.phase',data:{runId:'r',phase:'preparing'}})).toBe(done);
  expect(applyRunEvent(done,{event:'run.delta',data:{runId:'r',messageId:'a',text:'late'}})).toBe(done);
  expect(applyRunEvent(done,{event:'run.created',data:{runId:'r',messages:[]}})).toBe(done);
  expect(mergeInitial(done,[{event:'run.phase',data:{runId:'r',phase:'narrative'}}])).toEqual(done);
});

it('merges overlapping UTF-16 deltas and initial snapshots without losing newer suffixes',()=>{
  const runs:Run[]=[{id:'r',status:'running',messages:[{id:'m',role:'assistant',text:'A😀'}]}];
  const delta:RunEvent={event:'run.delta',data:{runId:'r',messageId:'m',offset:1,text:'😀BC'}};
  const merged=mergeInitial(runs,[delta]);
  expect(merged[0]!.messages[0]!.text).toBe('A😀BC');
  expect(applyRunEvent(merged,delta)).toBe(merged);
  expect(mergeHistory(merged,runs)[0]!.messages[0]!.text).toBe('A😀BC');
  expect(applyRunEvent(merged,{event:'run.snapshot',data:{runId:'r',status:'preparing',phase:'preparing',messages:[]}})[0]!.phase).toBe('narrative');
  expect(hasDeltaGap(runs,{event:'run.delta',data:{runId:'r',messageId:'m',offset:4,text:'C'}})).toBe(true);
  expect(hasDeltaGap(runs,{event:'run.delta',data:{runId:'r',messageId:'m',offset:0,text:'wrong'}})).toBe(true);
});

it('recovers running messages from snapshots, preserves historical identities, and clears uncommitted text on terminal failure',()=>{
  const old:Run={id:'old',status:'completed',messages:[{id:'old-m',role:'assistant',text:'history'}]};
  const live=applyRunEvent([old],{event:'run.snapshot',data:{runId:'r',status:'running',phase:'narrative',messages:[{id:'m',role:'assistant',text:'live'}]}});
  expect(live[0]).toBe(old);
  const done=applyRunEvent(live,{event:'run.failed',data:{runId:'r',messages:[],errorCode:'STATE_COMMIT_FAILED',errorMessage:'failed'}});
  expect(done[1]!.messages).toEqual([]);
  expect(applyRunEvent(done,{event:'run.snapshot',data:{runId:'r',status:'running',messages:[{id:'m',role:'assistant',text:'late'}]}})).toBe(done);
});
