import {expect,it} from 'vitest';
import {ActionSuggestionStore} from '../../studio/src/features/sessions/action-suggestions.js';
import {runtimeFixture,textGateway,tail,drain} from './fixtures/runtime-v2.js';
const batch=(runId:string,messageId='m')=>({sessionId:'s',suggestions:{runId,messageId,items:['慢一点','向前走','出发吧']}});
it('clears only on new accepted run and rejects duplicates, stale runs, foreign sessions and wrong message IDs',()=>{
 const events:any[]=[],store=new ActionSuggestionStore('s',e=>events.push(e));
 store.accepted('r1');store.settled('r1','completed',[{id:'m',role:'assistant'}]);store.receive(batch('r1'));
 expect(events.at(-1).data.suggestions.runId).toBe('r1');const count=events.length;
 store.accepted('r1');store.receive(batch('r1'));expect(events).toHaveLength(count); // late 202 / duplicate
 store.receive({...batch('r1'),sessionId:'other'});store.receive(batch('r1','wrong'));expect(events).toHaveLength(count);
 store.accepted('r2');expect(events.at(-1).data.suggestions).toBeNull();store.receive(batch('r1'));store.accepted('r1');expect(events.at(-1).data.suggestions).toBeNull();
 store.settled('r2','failed',[]);store.receive(batch('r2'));expect(events.at(-1).data.suggestions).toBeNull();
});
it('verification and session reset never reconstruct missed suggestions',()=>{
 const events:any[]=[],store=new ActionSuggestionStore('s',e=>events.push(e));store.accepted('r');store.settled('r','completed',[{id:'m',role:'assistant'}]);store.receive(batch('r'));
 store.verifyLatest('r');expect(events.at(-1).data.suggestions).not.toBeNull();store.verifyLatest('new');expect(events.at(-1).data.suggestions).toBeNull();store.reset();store.receive(batch('r'));expect(events.at(-1).data.suggestions).toBeNull();
});
it('ignores stale reconnect verification after a newer run is accepted',()=>{
 const events:any[]=[],store=new ActionSuggestionStore('s',e=>events.push(e));
 store.accepted('r1');const version=store.version;
 store.accepted('r2');store.settled('r2','completed',[{id:'m',role:'assistant'}]);store.receive(batch('r2'));
 store.verifyLatest('r1',version);expect(events.at(-1).data.suggestions.runId).toBe('r2');
 store.verifyLatest('r3',store.version);expect(events.at(-1).data.suggestions).toBeNull();
});
it('publishes once after authoritative terminal and never stores suggestion contents in history/status/database',async()=>{
 const items=['PRIVATE_SUGGESTION_1','PRIVATE_SUGGESTION_2','PRIVATE_SUGGESTION_3'];
 const {db,runtime}=runtimeFixture(textGateway('story'+tail([{path:'score',value:1}],items),{finalOnly:true}));
 try{
  const events:any[]=[];runtime.onEvent((_id,event,payload)=>events.push({event,payload}));
  const run=await runtime.prepare('session','go','req','opening');await drain(run.stream);
  const event=events.find(e=>e.event==='action_suggestions.changed');expect(event.payload.suggestions.items).toEqual(items);
  expect(events.indexOf(event)).toBeGreaterThan(events.findIndex(e=>e.event==='run.updated'&&e.payload.status==='completed'));
  expect(runtime.status('session',run.runId)?.messages).toContainEqual(expect.objectContaining({id:event.payload.suggestions.messageId,role:'assistant'}));
  for(const value of [runtime.status('session',run.runId),runtime.history('session',String(db.prepare('SELECT tip_entry_id FROM sessions').get()!.tip_entry_id),5),db.prepare('SELECT * FROM entries').all(),db.prepare('SELECT * FROM sessions').all()])expect(JSON.stringify(value)).not.toContain('PRIVATE_SUGGESTION');
 }finally{db.close();}
});
