import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadStageWorld} from '../src/features/worlds/stage-world.ts';

const world=()=>({
  id:'world/one',publication:{release:{version:'1.0.0'}},revision:2,name:'世界',characters:[],openings:[],components:[{id:'stage',path:'components/stage.tsx'},{id:'bad',path:'components/bad.tsx'}],
  stageComponent:'stage',messageRender:{rules:[{id:'card',roles:['assistant'],pattern:'card',replacement:{type:'component',component:'bad'}}]},
  stateDefinition:{schema_version:2,scopes:{global:{weather:{initial:'clear',rules:{weather:'private'}}},message:{coins:{initial:8}}}},
});

test('stage world loads current V2 fields, package resources and a minimal state manifest',async()=>{
  const item=world(),calls=[],modules={code:{stage:'compiled'},errors:{bad:'broken source'}};
  const result=await loadStageWorld(item.id,undefined,{
    origin:'http://127.0.0.1:5176',
    request:async(path,options)=>{calls.push({path,options});return {item};},
    loadComponents:async received=>{assert.equal(received,item);return modules;},
  });
  assert.equal(calls[0].path,'v1/worlds/world%2Fone');
  assert.equal(result.world,item);assert.equal(result.main,'stage');
  assert.deepEqual(result.modules,modules);
  assert.deepEqual(result.state,{scopes:{global:{weather:true},message:{coins:true}}});
  assert.equal(JSON.stringify(result.state).includes('private'),false);
  assert.equal(result.assetBaseUrl,'http://127.0.0.1:5176/api/v1/worlds/world%2Fone/resources/');
  assert.deepEqual(result.rules,item.messageRender.rules);
  result.rules[0].pattern='changed';assert.equal(item.messageRender.rules[0].pattern,'card');
});

test('unused component errors remain local and an official stage needs no custom component',async()=>{
  const item={...world(),stageComponent:null,messageRender:null,stateDefinition:null,components:null};
  const result=await loadStageWorld(item.id,undefined,{
    origin:'https://web.test',request:async()=>({item}),
    loadComponents:async()=>({code:{},errors:{unused:'load failed'}}),
  });
  assert.equal(result.main,null);assert.deepEqual(result.rules,[]);assert.deepEqual(result.state,{scopes:{}});
  assert.deepEqual(result.modules.errors,{unused:'load failed'});
});

test('aborted loading never compiles or returns a late world',async()=>{
  const item=world(),before=new AbortController();let compiled=0;
  await assert.rejects(loadStageWorld(item.id,before.signal,{
    request:async()=>{before.abort();return {item};},
    loadComponents:async()=>{compiled++;return {code:{},errors:{}};},
  }),{name:'AbortError'});
  assert.equal(compiled,0);
  const during=new AbortController();
  await assert.rejects(loadStageWorld(item.id,during.signal,{
    request:async()=>({item}),loadComponents:async()=>{during.abort();return {code:{},errors:{}};},
  }),{name:'AbortError'});
});

test('world identity and shape are checked before component loading',async()=>{
  let compiled=false;
  await assert.rejects(loadStageWorld('expected',undefined,{
    request:async()=>({item:world()}),loadComponents:async()=>{compiled=true;return {code:{},errors:{}};},
  }),/世界响应格式无效/);
  assert.equal(compiled,false);
});

test('reconnect checks the current release without recompiling unchanged author content',async()=>{
  const first={...world(),publication:{release:{version:'1.2.0'}}};
  const modules={code:{stage:'first'},errors:{bad:'old error'}};
  const original=await loadStageWorld(first.id,undefined,{request:async()=>({item:first}),loadComponents:async()=>modules});
  const renamed={...first,name:'Local name',revision:99};
  const unchanged=await loadStageWorld(first.id,undefined,{
    previous:original,request:async()=>({item:renamed}),loadComponents:async()=>assert.fail('same release does not recompile'),
  });
  assert.equal(unchanged.modules,modules);
  assert.equal(unchanged.world.name,'Local name');
  const updated={...renamed,publication:{release:{version:'1.3.0'}}};
  const compiled={code:{stage:'new content at the same file path'},errors:{}};
  const next=await loadStageWorld(first.id,undefined,{
    previous:unchanged,request:async()=>({item:updated}),loadComponents:async()=>compiled,
  });
  assert.equal(next.modules,compiled);
  assert.deepEqual(next.modules.errors,{});
  assert.equal(next.world.publication.release.version,'1.3.0');
});
