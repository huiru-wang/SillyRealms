import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPreviewSourceCache,previewContentIdentity,retainPreview} from '../src/features/worlds/preview-cache.ts';
import {createPreviewActivity} from '../src/features/worlds/preview-activity.ts';

const preview=id=>({id,entry:'component-'+id,title:id});
const modules=value=>({code:{entry:value},errors:{}});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

test('ten previews survive tab revisits; the eleventh evicts first opened, not least recently visited',()=>{
  let entries=[];
  const ids=['introduction',...Array.from({length:9},(_,i)=>'opening:'+i)];
  for(const id of ids)entries=retainPreview(entries,preview(id));
  const full=entries;
  assert.strictEqual(retainPreview(entries,null),full); // Other tabs do not release previews.
  assert.strictEqual(retainPreview(entries,preview('introduction')),full);
  entries=retainPreview(entries,preview('opening:9'));
  assert.equal(entries.length,10);
  assert.deepEqual(entries.map(item=>item.id),[...ids.slice(1),'opening:9']);
  for(let i=0;i<9;i++)assert.strictEqual(entries[i],full[i+1]);
  entries=retainPreview(entries,preview('introduction'));
  assert.deepEqual(entries.map(item=>item.id),[...ids.slice(2),'opening:9','introduction']);
});

test('different openings using the same module keep separate instances; title changes do not promote them',()=>{
  const first={id:'opening:one',entry:'shared',title:'One'};
  const second={id:'opening:two',entry:'shared',title:'Two'};
  let entries=retainPreview(retainPreview([],first),second);
  entries=retainPreview(entries,{...first,title:'Renamed'});
  assert.deepEqual(entries.map(item=>item.id),[first.id,second.id]);
  assert.equal(entries[0].title,'Renamed');
  assert.strictEqual(entries[1],second);
});

test('management saves preserve preview identity; world or author source changes invalidate it',()=>{
  const world={id:'one',components:[{id:'entry',component:'source'}],name:'Name',revision:1};
  const identity=previewContentIdentity(world);
  assert.equal(previewContentIdentity({...structuredClone(world),name:'Renamed',revision:2,tags:['new']}),identity);
  assert.notEqual(previewContentIdentity({...world,id:'two'}),identity);
  assert.notEqual(previewContentIdentity({...world,components:[{id:'entry',component:'edited'}]}),identity);
});

test('new previews share both in-flight source loading and its successful result',async()=>{
  const pending=deferred();let calls=0;
  const source=createPreviewSourceCache(()=>{calls++;return pending.promise;});
  const one=source.read(),two=source.read();
  assert.strictEqual(one,two);
  pending.resolve(modules('first'));
  await Promise.all([one,two]);
  assert.strictEqual(source.read(),one);
  assert.equal(calls,1);
  source.dispose();
});

test('retry refreshes source without aborting another loading frame or replacing the newer cache with an old response',async()=>{
  const old=deferred(),fresh=deferred(),signals=[];
  const source=createPreviewSourceCache(signal=>{signals.push(signal);return signals.length===1?old.promise:fresh.promise;});
  const first=source.read();await Promise.resolve();
  const retry=source.read(true);await Promise.resolve();
  assert.equal(signals[0].aborted,false);
  fresh.resolve(modules('fresh'));await retry;
  old.resolve(modules('old'));await first;
  assert.strictEqual(source.read(),retry);
  assert.equal((await source.read()).code.entry,'fresh');
  source.dispose();
});

test('source failures and per-module errors remain retryable',async()=>{
  let calls=0;
  const source=createPreviewSourceCache(async()=>{
    calls++;
    if(calls===1)throw Error('unavailable');
    if(calls===2)return {code:{},errors:{entry:'missing file'}};
    return modules('repaired');
  });
  await assert.rejects(source.read(),/unavailable/);
  assert.equal((await source.read()).errors.entry,'missing file');
  assert.equal((await source.read()).code.entry,'repaired');
  assert.equal(calls,3);
  source.dispose();
});

test('leaving the detail aborts all outstanding loads and prevents late results from repopulating its cache',async()=>{
  const pending=[deferred(),deferred()],signals=[];
  const source=createPreviewSourceCache(signal=>{signals.push(signal);return pending[signals.length-1].promise;});
  const first=source.read();await Promise.resolve();
  const second=source.read(true);await Promise.resolve();
  source.dispose();
  assert.ok(signals.every(signal=>signal.aborted));
  const settled=Promise.allSettled([first,second]);
  pending.forEach(item=>item.resolve(modules('late')));
  assert.ok((await settled).every(result=>result.status==='rejected'&&result.reason.name==='AbortError'));
});

test('effect cleanup and reactivation cannot poison the next shared load',async()=>{
  let calls=0;
  const source=createPreviewSourceCache(async()=>{calls++;return modules('new');});
  const abandoned=source.read();
  source.dispose();
  const next=source.read();
  await assert.rejects(abandoned,{name:'AbortError'});
  assert.equal((await next).code.entry,'new');
  assert.equal(calls,1);
  assert.strictEqual(source.read(),next);
  source.dispose();
});

test('inactive cached previews pause media, reject background playback, and never auto-resume audio',()=>{
  const listeners=new Map(),attributes=new Map();
  let pauses=0;
  const media={tagName:'AUDIO',pause(){pauses++;}};
  const doc={hidden:false,documentElement:{toggleAttribute:(name,value)=>attributes.set(name,value)},
    querySelectorAll:()=>[media],addEventListener:(type,fn)=>listeners.set(type,fn),removeEventListener:type=>listeners.delete(type)};
  const activity=createPreviewActivity(doc);
  assert.equal(activity.active,true);
  activity.setActive(false);
  assert.equal(activity.active,false);assert.equal(pauses,1);
  assert.equal(attributes.get('data-preview-inactive'),true);
  listeners.get('play')({target:media});assert.equal(pauses,2);
  activity.setActive(true);assert.equal(activity.active,true);assert.equal(pauses,2);
  doc.hidden=true;listeners.get('visibilitychange')();assert.equal(activity.active,false);assert.equal(pauses,3);
  activity.setActive(false);
  doc.hidden=false;listeners.get('visibilitychange')();assert.equal(activity.active,false);
  activity.dispose();assert.equal(listeners.size,0);
});
