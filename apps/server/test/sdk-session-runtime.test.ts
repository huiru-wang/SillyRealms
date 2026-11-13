import { expect,it } from 'vitest';
import { SessionRuntime } from '../../../packages/sr-sdk/src/session-runtime.js';

it('forwards draft commands and Run events without reconstructing missing fragments',async()=>{
  const drafts:string[]=[];
  const runtime=new SessionRuntime({send:async()=>({runId:'r',requestId:'q'}),history:async()=>({runs:[],hasMore:false,nextCursor:null}),setDraft:text=>drafts.push(text)});
  runtime.setDraft('你好');expect(drafts).toEqual(['你好']);
  const received:string[]=[];const unsubscribe=runtime.subscribe(event=>received.push(event.event));
  runtime.accept({event:'run.delta',data:{runId:'r',messageId:'m',text:'后续'}});
  runtime.accept({event:'run.stopped',data:{runId:'r',messages:[]}});
  expect(received).toEqual(['run.delta','run.stopped']);expect(await runtime.send('你好')).toEqual({runId:'r',requestId:'q'});
  unsubscribe();runtime.setDraft('再见');expect(drafts).toEqual(['你好','再见']);
});

it('requires explicit phase subscription and isolates independent listeners',()=>{
  const runtime=new SessionRuntime({send:async()=>({runId:'r',requestId:'q'}),history:async()=>({runs:[],hasMore:false,nextCursor:null}),setDraft:()=>{}});
  const old:string[]=[],extended:string[]=[];
  runtime.subscribe(event=>old.push(event.event));
  const unsubscribe=runtime.subscribe(event=>extended.push(event.event),{includePhase:true});
  runtime.accept({event:'run.phase',data:{runId:'r',phase:'extensions'}});
  runtime.accept({event:'run.completed',data:{runId:'r',messages:[],executionMode:'direct',phase:'finalized'}});
  expect(old).toEqual(['run.completed']);expect(extended).toEqual(['run.phase','run.completed']);
  unsubscribe();runtime.accept({event:'run.phase',data:{runId:'r',phase:'preparing'}});
  expect(extended).toHaveLength(2);
});
