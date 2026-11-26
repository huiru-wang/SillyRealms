import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ApiError} from '../src/api.ts';
import {createWorldVersionsController,hasWorldUpdate,releaseDirection,worldReleaseIdentity,publicationLink} from '../src/features/worlds/versions.ts';
import {i18n} from '../src/i18n/instance.ts';
import {errorMessage} from '../src/i18n/errors.ts';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const release=(version='1.10.0')=>({
  version,published_at:'2026-11-26T00:00:00Z',notes:'Release notes',spec_version:'0.2',supported:true,
  artifact:{format:'zip',url:'https://example.org/world.zip',sha256:'a'.repeat(64),size_bytes:123},
});
const versions=(patch={})=>({
  worldId:'world/one',currentVersion:'1.2.0',latestVersion:'1.10.0',updateStatus:'ready',
  lastSuccessAt:10,lastAttemptAt:10,errorCode:null,versions:[release(),release('1.2.0')],...patch,
});

test('version badges follow numeric release order, retain cached updates on failure and ignore invalid versions',()=>{
  assert.equal(hasWorldUpdate(versions()),true);
  assert.equal(hasWorldUpdate(versions({updateStatus:'failed'})),true);
  assert.equal(releaseDirection('1.10.0','1.2.0'),'downgrade');
  assert.equal(releaseDirection('1.10.0','1.10.0'),'current');
  for(const patch of [{currentVersion:null},{latestVersion:null},{latestVersion:'1.2'},{currentVersion:'01.2.0'},{currentVersion:'9.0.0'}]){
    assert.equal(hasWorldUpdate(versions(patch)),false);
  }
  const world={id:'w',publication:{release:{version:'1.2.0'}}};
  assert.equal(worldReleaseIdentity({...world,revision:10,name:'new'}),worldReleaseIdentity(world));
  assert.notEqual(worldReleaseIdentity({...world,publication:{release:{version:'1.3.0'}}}),worldReleaseIdentity(world));
  assert.equal(publicationLink('https://example.org/author'),'https://example.org/author');
  for(const unsafe of ['javascript:alert(1)','data:text/html,test','https://user:secret@example.org','/local']){
    assert.equal(publicationLink(unsafe),undefined);
  }
});

test('opening reads only the local endpoint, while explicit refresh sends no user-controlled source URL',async()=>{
  const calls=[],summaries=[],controller=createWorldVersionsController('world/one',{
    request:async(path,init)=>{calls.push({path,init});return {item:versions()};},
    onSummary:view=>summaries.push(view),onApplied:()=>assert.fail('refresh must not install'),
  });
  assert.deepEqual(calls,[]);
  await controller.load();
  assert.equal(calls[0].path,'v1/worlds/world%2Fone/versions');
  assert.equal(calls[0].init.method,undefined);
  await controller.refresh();
  assert.equal(calls[1].path,'v1/worlds/world%2Fone/versions/refresh');
  assert.equal(calls[1].init.method,'POST');
  assert.equal(calls[1].init.body,undefined);
  assert.equal(summaries.length,2);
  controller.dispose();
});

test('refresh coalesces clicks, supersedes a stale local read and preserves its newer list',async()=>{
  const local=deferred(),remote=deferred(),calls=[];
  const controller=createWorldVersionsController('world/one',{
    request:(path,init)=>{calls.push({path,init});return path.endsWith('/refresh')?remote.promise:local.promise;},
    onSummary:()=>{},onApplied:()=>{},
  });
  const reading=controller.load(),refreshing=controller.refresh();
  assert.equal(calls[0].init.signal.aborted,true);
  assert.strictEqual(controller.refresh(),refreshing);
  remote.resolve({item:versions()});await refreshing;
  local.resolve({item:versions({versions:[],latestVersion:null})});await reading;
  assert.equal(calls.length,2);
  assert.equal(controller.getSnapshot().view.latestVersion,'1.10.0');
  assert.equal(controller.getSnapshot().refreshing,false);
  controller.dispose();
});

test('a failed refresh keeps the last successful list and exposes the server failure without marking it current',async()=>{
  let fail=false;
  const failure=new ApiError('WORLD_DOWNLOAD_TIMEOUT','timeout',504);
  const controller=createWorldVersionsController('world/one',{
    request:async(path)=>{
      if(path.endsWith('/refresh')){fail=true;throw failure;}
      return {item:versions(fail?{updateStatus:'failed',lastAttemptAt:20,errorCode:failure.errorCode}:{})};
    },
    onSummary:()=>{},onApplied:()=>{},
  });
  await controller.load();await controller.refresh();
  const state=controller.getSnapshot();
  assert.equal(state.view.lastSuccessAt,10);
  assert.equal(state.view.versions.length,2);
  assert.equal(state.view.updateStatus,'failed');
  assert.equal(state.error,failure);
  assert.equal(hasWorldUpdate(state.view),true);
  assert.equal(state.refreshing,false);
  controller.dispose();
});

test('successful empty lists remove withdrawn versions and application carries only selected identity guards',async()=>{
  const applied=[],requests=[];
  const controller=createWorldVersionsController('world/one',{
    request:async(path,init)=>{
      requests.push({path,init});
      if(path.endsWith('/apply-version'))return {item:{id:'world/one',revision:8,currentVersion:'1.10.0',latestVersion:'1.10.0',updateStatus:'ready'}};
      return {item:versions(path.endsWith('/refresh')?{versions:[],latestVersion:null,lastSuccessAt:20}:{})};
    },
    onSummary:()=>{},onApplied:item=>applied.push(item),
  });
  await controller.load();
  const choice={version:'1.10.0',expectedSha256:'a'.repeat(64),expectedRevision:7};
  assert.equal(await controller.apply(choice),true);
  assert.deepEqual(JSON.parse(requests.at(-1).init.body),choice);
  assert.equal(hasWorldUpdate(controller.getSnapshot().view),false);
  assert.equal(applied[0].revision,8);
  await controller.refresh();
  assert.deepEqual(controller.getSnapshot().view.versions,[]);
  assert.equal(controller.getSnapshot().view.latestVersion,null);
  controller.dispose();
});

test('application conflicts retain the selected installed version and duplicate applications are blocked',async()=>{
  const pending=deferred();let posts=0;
  const controller=createWorldVersionsController('world/one',{
    request:async(path)=>path.endsWith('/apply-version')?(posts++,pending.promise):{item:versions()},
    onSummary:()=>{},onApplied:()=>assert.fail('a conflict cannot replace the world'),
  });
  await controller.load();
  const choice={version:'1.10.0',expectedSha256:'a'.repeat(64),expectedRevision:7};
  const first=controller.apply(choice);
  assert.equal(await controller.apply(choice),false);
  pending.reject(new ApiError('WORLD_REVISION_CONFLICT','changed',409));
  assert.equal(await first,false);
  assert.equal(posts,1);
  assert.equal(controller.getSnapshot().view.currentVersion,'1.2.0');
  assert.equal(controller.getSnapshot().error.errorCode,'WORLD_REVISION_CONFLICT');
  assert.equal(controller.getSnapshot().applying,null);
  controller.dispose();
});

test('disposing an outstanding read aborts it and discards a late successful result',async()=>{
  const pending=deferred();let signal;
  const controller=createWorldVersionsController('world/one',{
    request:async(_path,init)=>{signal=init.signal;return pending.promise;},
    onSummary:()=>assert.fail('disposed observer'),onApplied:()=>assert.fail('disposed observer'),
  });
  const reading=controller.load();controller.dispose();
  assert.equal(signal.aborted,true);
  pending.resolve({item:versions()});await reading;
  assert.equal(controller.getSnapshot().view,null);
});

test('publication actions and update errors follow all supported languages without translating creator data',async()=>{
  try{
    for(const locale of ['zh-CN','en','ja']){
      await i18n.changeLanguage(locale);
      for(const key of ['versions','creatorNotes','getVersions','refreshVersions','confirmCopy','confirmPreserved','requiresAppUpdate']){
        assert.equal(i18n.exists('worlds:publication.'+key),true,locale+' '+key);
      }
      for(const code of ['WORLD_UPDATE_BUSY','WORLD_UPDATE_INCOMPATIBLE','WORLD_DOWNLOAD_HASH_MISMATCH','WORLD_RELEASE_INDEX_WRITE_FAILED']){
        assert.notEqual(errorMessage(code),code);
        assert.notEqual(errorMessage(code),i18n.t('errors:unexpected'));
      }
      assert.match(i18n.t('worlds:publication.updateTo',{version:'1.10.0'}),/1\.10\.0/);
    }
  }finally{await i18n.changeLanguage('zh-CN');}
});
