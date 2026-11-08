import { expect,it } from 'vitest';
import { StateRuntime } from '../../../packages/sr-sdk/src/state-runtime.js';

it('reads server state, shares snapshots, and applies committed events',async()=>{
  let server={global:{},session:{},message:{角色:{好感:1}}};
  const runtime=new StateRuntime({read:async()=>structuredClone(server),write:async entries=>entries.map(entry=>({path:entry.path,scope:entry.scope??'message',success:true,message:''}))});
  let changes=0;const unobserve=runtime.observe(()=>changes++);const events:string[]=[];const unsubscribe=runtime.subscribe(event=>events.push(event.data.path));
  await runtime.refresh();expect(await runtime.getState('角色.好感')).toBe(1);
  await runtime.updateState('角色.好感',2);expect(runtime.getSnapshot().message.角色).toEqual({好感:2});
  server={global:{},session:{},message:{角色:{好感:3}}};runtime.accept({event:'state.changed',data:{path:'角色.好感',scope:'message',value:3}});
  expect(runtime.getSnapshot().message.角色).toEqual({好感:3});expect(events).toEqual(['角色.好感']);expect(changes).toBe(3);
  unsubscribe();unobserve();
});

it('refreshes again when a state event races the initial read',async()=>{
  let resolveFirst!:(value:{global:Record<string,never>;session:Record<string,never>;message:{角色:{好感:number}}})=>void;
  let reads=0;
  const runtime=new StateRuntime({
    read:()=>++reads===1?new Promise(resolve=>{resolveFirst=resolve;}):Promise.resolve({global:{},session:{},message:{角色:{好感:2}}}),
    write:async()=>[],
  });
  const refresh=runtime.refresh();
  runtime.accept({event:'state.changed',data:{path:'角色.好感',scope:'message',value:2}});
  resolveFirst({global:{},session:{},message:{角色:{好感:1}}});
  await refresh;
  expect(reads).toBe(2);
  expect(runtime.getSnapshot().message.角色).toEqual({好感:2});
});
