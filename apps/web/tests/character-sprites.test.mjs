import {safeImage} from '../src/features/worlds/resources.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSpriteController} from '../src/features/character-sprites/controller.ts';
import {appliedItems,spriteResource} from '../src/features/character-sprites/items.ts';
import {layoutSprites,stackComposerActions} from '../src/features/character-sprites/layout.ts';

const sprite=(position='right',characterId='keeper',spriteId='coat')=>({position,characterId,spriteId});
const frame=[sprite()];
const entry=(id,parentId,result,role='assistant')=>({
  id,parentId,sessionId:'s',role,type:'message',extData:{output:{characterSprite:result}},
});
const stored=items=>({status:'success',items});
const page=(entries,nextCursor=null)=>({items:[{entries}],nextCursor,hasMore:!!nextCursor});
function setup(entries,{older,message,readTip=async()=>null}={}) {
  const calls=[],queries=[];
  const history={
    getSnapshot:()=>({runs:[{entries}],hasMore:!!older,nextCursor:older?'older':null}),
    query:async(query,signal)=>{queries.push(query);return older(query,signal);},
  };
  const request=async(path,options)=>{
    calls.push(path);
    return message(path,options);
  };
  const sprites=createSpriteController({sessionId:'s',history,request,readTip,changed:()=>{}});
  sprites.bind('w');
  const restore=(id,known)=>sprites.restore(id,sprites.checkpoint(),known);
  return {sprites,restore,calls,queries};
}

test('recover along parent IDs across run pages, ignoring failed results and unrelated entries',async()=>{
  const {sprites,restore,calls,queries}=setup([
    entry('user','failed',null,'user'),entry('failed','old',{status:'invalid_items',items:[]}),
    entry('unrelated',null,stored([])),
  ],{older:async()=>page([entry('old',null,{status:'partial_success',items:frame})])});
  await restore('user');
  assert.deepEqual(sprites.getSnapshot().frame,{messageId:'old',items:frame});
  assert.deepEqual(queries,[{cursor:'older',limit:5}]);
  await restore('user');
  assert.equal(queries.length,1);
  assert.equal(calls.length,0);
});

test('live assets load directly and historical IDs resolve against the installed world release',()=>{
  const {sprites,calls}=setup([]);
  const live={...sprite(),asset:'sr-asset://assets/coat.webp'};
  sprites.accept({sessionId:'s',messageId:'new',runId:'r',items:[live]});
  const characters=[{id:'keeper',name:'守灯人',sprites:[{id:'coat',asset:'https://example.test/new.webp'}]}];
  const resource=()=>spriteResource(sprites.getSnapshot().frame.items[0],characters);
  assert.deepEqual(resource(),{name:'守灯人',asset:live.asset});
  const base='https://host.test/api/v1/worlds/w/resources/';
  assert.equal(safeImage(resource().asset,base),base+'assets/coat.webp');
  sprites.invalidateAssets();
  assert.deepEqual(resource(),{name:'守灯人',asset:'https://example.test/new.webp'});
  assert.equal(spriteResource(sprite(),[]).asset,undefined);
  assert.deepEqual(calls,[]);
});

test('stop recovery on explicit clear; all-invalid and missing do not provide a frame',async()=>{
  const {sprites,restore,queries}=setup([entry('clear','older',stored([]))]);
  await restore('clear');
  assert.deepEqual(sprites.getSnapshot().frame,{messageId:'clear',items:[]});
  assert.equal(queries.length,0);
  for(const result of [null,{status:'partial_success',items:[]},{status:'invalid_tag',items:[]},stored([sprite(),sprite()])]){
    assert.equal(appliedItems(result),null);
  }
});

test('use the specified committed assistant when only its ID is known',async()=>{
  const {sprites,restore,calls}=setup([],{message:async()=>({sessionId:'s',messageId:'a/1',result:stored(frame)})});
  await restore('a/1','a/1');
  assert.equal(calls[0],'v1/sessions/s/entries/a%2F1/character-sprites');
  assert.deepEqual(sprites.getSnapshot().frame,{messageId:'a/1',items:frame});
});

test('a parent deleted during recovery retries from the durable tip once',async()=>{
  const {sprites,restore,queries}=setup([entry('a','gone',null)],{
    older:async query=>query.cursor?page([]):page([entry('replacement',null,stored([]))]),
    readTip:async()=>'replacement',
  });
  await restore('a');
  assert.equal(queries.length,2);
  assert.deepEqual(sprites.getSnapshot().frame,{messageId:'replacement',items:[]});
});

test('an old recovery cannot replace a new event, and deletion cannot resurrect the old execution',async()=>{
  let reply;
  const {sprites,restore}=setup([entry('previous',null,stored(frame))],{
    message:()=>new Promise(resolve=>{reply=resolve;}),
  });
  const pending=restore('old','old');
  const changed=(id,items)=>sprites.accept({sessionId:'s',runId:'r',messageId:id,items});
  changed('old',[]);
  sprites.remove(['old'],'previous');
  assert.equal(sprites.getSnapshot().frame.messageId,'previous');
  changed('new',frame);
  reply({sessionId:'s',messageId:'old',result:stored([])});
  await pending;
  changed('old',[]);
  sprites.remove(['old'],'previous');
  assert.deepEqual(sprites.getSnapshot().frame,{messageId:'new',items:frame});
  sprites.bind(null);
  changed('new',frame);
  assert.equal(sprites.getSnapshot().frame,null);
});

test('restoring a clear received while hidden and isolating browser preferences by session',async t=>{
  const storage=new Map();
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{
    setItem:(key,value)=>storage.set(key,value),getItem:key=>storage.get(key)??null,
  }});
  t.after(()=>{if(descriptor)Object.defineProperty(globalThis,'localStorage',descriptor);else delete globalThis.localStorage;});
  const {sprites}=setup([]);
  sprites.setEnabled(false);
  sprites.accept({sessionId:'s',runId:'r',messageId:'clear',items:[]});
  assert.equal(sprites.getSnapshot().enabled,false);
  const second=setup([]);
  assert.equal(second.calls.length,0);
  assert.equal(second.sprites.getSnapshot().enabled,false);
  sprites.setEnabled(true);
  assert.deepEqual(sprites.getSnapshot().frame,{messageId:'clear',items:[]});
  assert.deepEqual([...storage.keys()],['sr:session:s:show-character-sprites']);
});

test('select stable figures by actual stage dimensions and semantic positions',()=>{
  const crowd=['top','truecenter','topleft','topright','center','right','left'].map(pos=>sprite(pos,pos));
  const selected=(items,w,h)=>layoutSprites(items,w,h).map(({side,item})=>[side,item.position]);
  assert.deepEqual(selected(crowd,1280,700),[['left','left'],['right','right']]);
  assert.deepEqual(selected(crowd,375,600),[['right','top']]);
  assert.deepEqual(selected([sprite('topleft')],320,500),[['right','topleft']]);
  assert.deepEqual(selected([sprite('center'),sprite('top')],1280,700),[['left','top'],['right','center']]);
  assert.deepEqual(selected(crowd,820,210),[]);
});

test('the author group wraps above the right toggle only when its centered width would collide',()=>{
  assert.equal(stackComposerActions(320,70,[],4),false);
  assert.equal(stackComposerActions(320,70,[70,98],4),false);
  assert.equal(stackComposerActions(320,70,[70,99],4),true);
  assert.equal(stackComposerActions(600,80,[100,100,100,100,100],4),true);
});
