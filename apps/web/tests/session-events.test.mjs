import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSessionEventChannel,SESSION_EVENT_NAMES} from '../src/transport/session-events.ts';
class Source{
 listeners=new Map(); closed=false;
 addEventListener(name,listener){this.listeners.set(name,listener);}
 close(){this.closed=true;}
 emit(name,data){this.listeners.get(name)?.({data:typeof data==='string'?data:JSON.stringify(data)});}
}
test('one session connection dispatches explicit namespaces and survives broken consumers',()=>{
 const source=new Source();let opened=0,url;
 const channel=createSessionEventChannel({sessionId:'s',createSource:path=>{opened++;url=path;return source;}});
 const seen=[],connections=[];
 channel.subscribeConnection(state=>connections.push(state));
 channel.subscribe('state',event=>{event.data.value.bad=true;throw Error('broken');});
 channel.subscribe('state',event=>seen.push(event));
 channel.subscribe('run',event=>seen.push(event));
 channel.connect();channel.connect();
 assert.equal(opened,1);assert.equal(url,'/api/v1/sessions/s/events');
 assert.deepEqual([...source.listeners.keys()].filter(name=>name!=='open'&&name!=='error'),SESSION_EVENT_NAMES);
 source.emit('open','');
 source.emit('state.changed',{path:'',scope:'message',value:{coins:8}});
 assert.deepEqual(seen[0].data,{path:'',scope:'message',value:{coins:8}});
 source.emit('run.completed',{sessionId:'s',runId:'r',assistantEntryId:'a',savedMessageIds:['u','a'],tipEntryId:'a'});
 assert.equal(seen.length,2);assert.equal(source.closed,false);
 source.emit('error','');source.emit('open','');
 assert.equal(connections.at(-1).generation,2);assert.equal(connections.at(-1).connected,true);
 channel.dispose();assert.equal(source.closed,true);
 source.emit('state.changed',{path:'coins',scope:'message',value:9});assert.equal(seen.length,2);
});
test('malformed, foreign-session and unsupported events cannot poison later valid events',()=>{
 const source=new Source(),seen=[];
 const channel=createSessionEventChannel({sessionId:'s',createSource:()=>source});
 channel.subscribe('*',event=>seen.push(event));channel.connect();
 source.emit('run.created','broken JSON');
 source.emit('run.delta',{sessionId:'other',runId:'r',messageId:'a',messages:[{}]});
 source.emit('run.phase',{sessionId:'s',runId:'r',phase:'old'});
 source.emit('state.changed',{path:'',scope:'invalid',value:{}});
 source.emit('action_suggestions.created',{sessionId:'s',runId:'r',messageId:'a',items:['向前']});
 assert.equal(seen.length,1);assert.equal(seen[0].event,'action_suggestions.created');
});

test('deletion and created events validate execution identity and the committed receipt',()=>{
 const source=new Source(),seen=[],channel=createSessionEventChannel({sessionId:'s',createSource:()=>source});
 channel.subscribe('*',event=>seen.push(event));channel.connect();
 const data={sessionId:'s',runId:'r',assistantEntryId:'new-a',messageId:'old-a',tipEntryId:'summary'};
 source.emit('message.deleted',data);source.emit('message.deleted',{...data,assistantEntryId:undefined});
 source.emit('run.created',{sessionId:'s',runId:'r',assistantEntryId:'new-a',messages:[{id:'u'}],tipEntryId:'summary',deletedMessageIds:['old-a']});
 source.emit('run.created',{sessionId:'s',runId:'r',assistantEntryId:'new-a',messages:[{id:'u'}]});
 assert.deepEqual(seen.map(event=>event.event),['message.deleted','run.created']);channel.dispose();
});

test('sprite events accept complete snapshots and explicit clearing, rejecting duplicate slots and characters',()=>{
 const source=new Source(),events=[],channel=createSessionEventChannel({sessionId:'s',createSource:()=>source});
 channel.subscribe('character_sprite',event=>events.push(event.data.items));channel.connect();
 const item={position:'right',characterId:'keeper',spriteId:'coat',asset:'sr-asset://assets/coat.webp'};
 for(const items of [[item],[],[{...item,asset:undefined}],[{...item,asset:' '}],[item,{...item,position:'left'}],[item,{...item,characterId:'other'}],[{...item,position:'below'}]]){
   source.emit('character_sprite.changed',{sessionId:'s',runId:'r',messageId:'a',items});
 }
 assert.deepEqual(events,[[item],[]]);channel.dispose();
});

test('world updates use the same session channel with a validated world namespace and no run identity',()=>{
  const source=new Source(),events=[],channel=createSessionEventChannel({sessionId:'s',createSource:()=>source});
  channel.subscribe('world',event=>events.push(event));channel.connect();
  const data={sessionId:'s',worldId:'w',version:'1.2.0',revision:2,timestamp:100};
  source.emit('world.updated',data);
  for(const invalid of [{sessionId:'other'},{worldId:''},{version:'v1.2.0'},{revision:0},{revision:1.5},{timestamp:'100'}]){
    source.emit('world.updated',{...data,...invalid});
  }
  assert.deepEqual(events,[{event:'world.updated',data}]);
  channel.dispose();
});
