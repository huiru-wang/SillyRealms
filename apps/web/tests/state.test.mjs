import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createStateController} from '../src/features/state/index.ts';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const receipt=(scope,path,success=true)=>success?{scope,path,success:true,errorCode:null,errorMessage:''}:
  {scope,path,success:false,errorCode:'INVALID_STATE_VALUE',errorMessage:'字段值无效'};
const event=(scope,path,value)=>({event:'state.changed',data:{scope,path,value}});
const pathScope=path=>path.split('/')[2];

test('state reads V2 owner endpoints and normalizes inherited message arrays without flattening null',async()=>{
  const calls=[],message=[{key:'coins',value:8},{key:'object',value:{present:null}},{key:'empty',value:null}];
  const controller=createStateController({worldId:'world/a',sessionId:'session/b',getTipEntryId:()=> 'entry/c',
    request:async path=>{calls.push(path);return {item:pathScope(path)==='message'?message:{enabled:true}};}});
  const values=await controller.read();
  assert.deepEqual(calls,['v1/state/global/world%2Fa','v1/state/session/session%2Fb','v1/state/message/session%2Fb/entry%2Fc']);
  assert.deepEqual(values.message,{coins:8,object:{present:null},empty:null});
  message[0].value=99;values.message.coins=100;
  assert.equal(controller.getSnapshot().values.message.coins,8);
  assert.equal(controller.getSnapshot().loading,false);
  controller.dispose();
});

test('events during an initial read trigger an authoritative reread and preserve unrelated roots',async()=>{
  const first=deferred();let globalReads=0;
  const controller=createStateController({worldId:'w',sessionId:'s',getTipEntryId:()=> 'tip',request:async path=>{
    if(pathScope(path)==='global'){globalReads++;return globalReads===1?first.promise:{item:{weather:{sky:'rain'},unrelated:7}};}
    return {item:pathScope(path)==='message'?[]:{}};
  }});
  const reading=controller.read();await tick();
  controller.accept(event('global','weather.sky','rain'));
  first.resolve({item:{weather:{sky:'clear'},unrelated:7}});
  const values=await reading;
  assert.equal(globalReads,2);
  assert.deepEqual(values.global,{weather:{sky:'rain'},unrelated:7});
  controller.dispose();
});

test('overlapping reads share a final generation and message reads follow a changed real tip',async()=>{
  let tip='old',globalReads=0;const firstGlobal=deferred(),firstMessage=deferred(),calls=[];
  const controller=createStateController({worldId:'w',sessionId:'s',getTipEntryId:()=> tip,request:async path=>{
    calls.push(path);
    if(pathScope(path)==='global')return ++globalReads===1?firstGlobal.promise:{item:{version:2}};
    if(pathScope(path)==='session')return {item:{}};
    if(path.endsWith('/old'))return firstMessage.promise;
    return {item:[{key:'coins',value:12}]};
  }});
  const first=controller.read();await tick();
  tip='new';const second=controller.read();
  firstGlobal.resolve({item:{version:1}});firstMessage.resolve({item:[{key:'coins',value:4}]});
  const values=await Promise.all([first,second]);
  assert.deepEqual(values[0],values[1]);assert.equal(values[0].global.version,2);assert.equal(values[0].message.coins,12);
  assert.ok(calls.includes('v1/state/message/s/new'));
  controller.dispose();
});

test('mixed scopes preserve batch order, retain individual failures and never invent ignored paths',async()=>{
  const values={global:{a:1},session:{b:2},message:{coins:8}},patches=[];
  const controller=createStateController({worldId:'w',sessionId:'s',getTipEntryId:()=> 'tip',request:async(path,options={})=>{
    const scope=pathScope(path);
    if(options.method==='PATCH'){
      const {updates}=JSON.parse(options.body);patches.push({scope,updates});
      return updates.map(({path,value})=>{
        if(value==='invalid')return receipt(scope,path,false);
        if(Object.hasOwn(values[scope],path))values[scope][path]=value;
        return receipt(scope,path);
      });
    }
    return {item:scope==='message'?Object.entries(values.message).map(([key,value])=>({key,value})):structuredClone(values[scope])};
  }});
  await controller.read();
  const results=await controller.write([
    {scope:'global',path:'a',value:2},{scope:'global',path:'a',value:'invalid'},
    {scope:'session',path:'b',value:3},{scope:'global',path:'missing',value:77},
    {path:'coins',value:null},
  ]);
  assert.deepEqual(patches.map(item=>item.scope),['global','session','global','message']);
  assert.deepEqual(patches[0].updates,[{path:'a',value:2},{path:'a',value:'invalid'}]);
  assert.deepEqual(results.map(item=>item.success),[true,false,true,true,true]);
  assert.deepEqual(controller.getSnapshot().values,{global:{a:2},session:{b:3},message:{coins:null}});
  assert.equal(Object.hasOwn(controller.getSnapshot().values.global,'missing'),false);
  assert.match(controller.getSnapshot().error,/字段值无效/);
  controller.dispose();
});

test('a failed scope and a failed follow-up read cannot cancel later writes or change successful receipts',async()=>{
  const patches=[];let written=false;
  const controller=createStateController({worldId:'w',sessionId:'s',getTipEntryId:()=> 'tip',request:async(path,options={})=>{
    const scope=pathScope(path);
    if(options.method==='PATCH'){
      patches.push(scope);
      if(scope==='global')throw Object.assign(Error('全局状态不可用'),{errorCode:'WORLD_NOT_FOUND'});
      written=true;return JSON.parse(options.body).updates.map(update=>receipt(scope,update.path));
    }
    if(scope==='session'&&written)throw Error('补读中断');
    return {item:scope==='message'?[]:{}};
  }});
  const results=await controller.write([{scope:'global',path:'a',value:1},{scope:'session',path:'b',value:2}]);
  assert.deepEqual(patches,['global','session']);
  assert.equal(results[0].errorCode,'WORLD_NOT_FOUND');assert.equal(results[1].success,true);
  assert.match(controller.getSnapshot().error,/补读中断/);
  controller.dispose();
});

test('complete replacements clear removed roots and null field events remain ordinary values',async()=>{
  let global={keep:1,remove:2},message=[{key:'coins',value:9}];const puts=[];
  const controller=createStateController({worldId:'w',sessionId:'s',getTipEntryId:()=> 'tip',request:async(path,options={})=>{
    const scope=pathScope(path);
    if(options.method==='PUT'){
      const {state}=JSON.parse(options.body);puts.push({scope,state});
      if(scope==='global')global=state;if(scope==='message')message=state;
      return {item:state};
    }
    return {item:scope==='global'?global:scope==='message'?message:{}};
  }});
  await controller.read();
  controller.accept(event('global','',{keep:1}));
  assert.equal(Object.hasOwn(controller.getSnapshot().values.global,'remove'),false);
  controller.accept(event('global','keep',null));assert.deepEqual(controller.getSnapshot().values.global,{keep:null});
  await controller.replace('global',{});
  await controller.replace('message',null);
  assert.deepEqual(puts,[{scope:'global',state:{}},{scope:'message',state:null}]);
  assert.deepEqual(controller.getSnapshot().values,{global:{},session:{},message:{}});
  controller.dispose();
});

test('writes are serialized across callers and malformed fields are isolated before sending',async()=>{
  const first=deferred(),patches=[];
  const controller=createStateController({worldId:'w',sessionId:'s',getTipEntryId:()=> 'tip',request:async(path,options={})=>{
    const scope=pathScope(path);
    if(options.method==='PATCH'){
      const updates=JSON.parse(options.body).updates;patches.push(updates);
      if(patches.length===1)await first.promise;
      return updates.map(update=>receipt(scope,update.path));
    }
    return {item:scope==='message'?[]:{}};
  }});
  const one=controller.write([{scope:'global',path:'a',value:1}]);
  const two=controller.write([{scope:'global',path:'__proto__.bad',value:2},{scope:'global',path:'b',value:3}]);
  await tick();assert.equal(patches.length,1);first.resolve();
  assert.equal((await one)[0].success,true);
  assert.deepEqual((await two).map(item=>item.success),[false,true]);
  assert.deepEqual(patches,[[{path:'a',value:1}],[{path:'b',value:3}]]);
  assert.equal({}.bad,undefined);controller.dispose();
});

test('observer exceptions are isolated and disposing aborts reads without publishing late values',async()=>{
  const pending=deferred();let observed=0,signal;
  const controller=createStateController({worldId:'w',sessionId:'s',getTipEntryId:()=> null,request:async(path,options)=>{
    signal=options.signal;return pathScope(path)==='global'?pending.promise:{item:{}};
  }});
  controller.subscribe(()=>{throw Error('broken observer');});controller.subscribe(()=>observed++);
  controller.accept(event('session','flag',true));assert.equal(observed,1);
  const reading=controller.read();await tick();
  const atDispose=observed;controller.dispose();assert.equal(signal.aborted,true);
  pending.resolve({item:{late:true}});
  await assert.rejects(reading,{name:'AbortError'});
  controller.accept(event('global','late',true));
  assert.equal(observed,atDispose);assert.deepEqual(controller.getSnapshot().values.global,{});
  await assert.rejects(controller.read(),{name:'AbortError'});
  await assert.rejects(controller.write([]),{name:'AbortError'});
});

test('a scope read failure retains successful siblings and a missing tip does not invent an entry URL',async()=>{
  const calls=[];
  const controller=createStateController({worldId:'w',sessionId:'s',getTipEntryId:()=> null,request:async path=>{
    calls.push(path);
    if(pathScope(path)==='global')throw Error('世界状态读取失败');
    return {item:{score:4}};
  }});
  await assert.rejects(controller.read(),/世界状态读取失败/);
  assert.deepEqual(controller.getSnapshot().values,{global:{},session:{score:4},message:{}});
  assert.equal(calls.some(path=>path.includes('/message/')),false);
  const result=await controller.write([{path:'coins',value:5}]);
  assert.equal(result[0].success,false);
  controller.dispose();
});
