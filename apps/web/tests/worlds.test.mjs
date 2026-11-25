import {test} from 'node:test';
import assert from 'node:assert/strict';
import {worldAssetBaseUrl,safeImage} from '../src/features/worlds/resources.ts';
import {worldPreviewURL} from '../src/features/worlds/preview-url.ts';
import {worldStateQueries,readWorldState} from '../src/features/worlds/world-component-protocol.ts';
import {parseTags,libraryReturn} from '../src/features/worlds/management.ts';
import {readWorldDownload} from '../src/features/worlds/download.ts';
import {createPreviewCompiler} from '../src/features/worlds/preview-compilation-cache.ts';
test('world resource addresses retain the package directory and reject unsafe image paths',()=>{
 const base=worldAssetBaseUrl('http://127.0.0.1:5176','world');
 assert.equal(base,'http://127.0.0.1:5176/api/v1/worlds/world/resources/');
 assert.equal(safeImage('sr-asset://assets/cover.png',base),base+'assets/cover.png');
 assert.equal(safeImage('sr-asset://assets/../secret',base),undefined);
 assert.equal(safeImage('javascript:alert(1)',base),undefined);
 assert.equal(safeImage(null,base),undefined);
 assert.equal(safeImage('https://user:secret@example.com/image.png',base),undefined);
 assert.equal(safeImage('sr-asset://assets/封面.png',base),base+'assets/'+encodeURIComponent('封面.png'));
 assert.equal(safeImage('sr-asset://assets/cover.png','http://127.0.0.1/world-assets/old/'),undefined);
 assert.equal(safeImage('sr-asset://assets/a.png','http://127.0.0.1/api/v1/app-settings/'),undefined);
});
test('preview origins are isolated and HTTPS hosts cannot downgrade',()=>{
 const url=worldPreviewURL('http://127.0.0.1:5177','http://127.0.0.1:5176','nonce');
 assert.equal(url.pathname,'/world-component.html');assert.equal(url.searchParams.get('hostOrigin'),'http://127.0.0.1:5176');
 for(const origin of ['http://127.0.0.1:5176','http://localhost/path','javascript:x'])assert.throws(()=>worldPreviewURL(origin,'http://127.0.0.1:5176','nonce'));
 assert.throws(()=>worldPreviewURL('http://localhost:5177','https://web.test','nonce'));
});
test('the host projects only requested global paths and rejects every write/scope escalation',()=>{
 assert.deepEqual(worldStateQueries('world.state.read',{entries:[{path:'weather.sky'}]}),[{path:'weather.sky',scope:'global'}]);
 assert.equal(readWorldState({weather:{sky:'clear'},private:'not requested'},'weather.sky'),'clear');
 assert.throws(()=>worldStateQueries('state.set',{entries:[]}));
 assert.throws(()=>worldStateQueries('world.state.read',{entries:[{path:'x',scope:'session'}]}));
 assert.throws(()=>worldStateQueries('world.state.read',{entries:[{path:'__proto__.x'}]}));
});
test('tag normalization is ordered and list navigation stays inside worlds',()=>{
 assert.deepEqual(parseTags(' 夜，海港\n夜, 山 '),['夜','海港','山']);
 assert.equal(libraryReturn('q=港&tag=夜&redirect=https://evil.test'),'/worlds?tag=%E5%A4%9C');
});
test('downloads reject error envelopes and preserve JSON originals as attachments',async()=>{
 await assert.rejects(readWorldDownload(new Response(JSON.stringify({errorMessage:'世界不存在'}),{status:404}),'world.zip'),/世界不存在/);
 await assert.rejects(readWorldDownload(new Response('{}'),'world.zip'),/下载响应无效/);
 const file=await readWorldDownload(new Response('{"original":true}',{headers:{'Content-Type':'application/json','Content-Disposition':'attachment; filename="original.json"'}}),'fallback');
 assert.equal(file.filename,'original.json');assert.equal(await file.blob.text(),'{"original":true}');
});
test('preview compilation reuses content and invalidates edited sources or failed compilation',async()=>{
 let count=0;const compile=createPreviewCompiler(async sources=>{count++;return {code:{entry:sources[0].component},errors:sources[0].component==='bad'?{entry:'invalid'}:{}};});
 const source=[{id:'entry',component:'one'}];await compile('world',source);await compile('world',source);assert.equal(count,1);
 source[0].component='two';await compile('world',source);assert.equal(count,2);
 source[0].component='bad';await compile('world',source);await compile('world',source);assert.equal(count,4);
});

test('opening state previews preserve complete defaults and reject undeclared overrides',async()=>{
 const {openingStateRows}=await import('../src/features/worlds/opening-state.ts');
 const state={schema_version:2,scopes:{message:{coins:{type:'number',initial:3,description:'金币',rules:{coins:'交易'}}}}};
 assert.deepEqual(openingStateRows(state,{coins:0}),[{name:'coins',value:0,overridden:true}]);
 assert.equal(state.scopes.message.coins.initial,3);
 assert.throws(()=>openingStateRows(state,{unknown:1}),/STATE_NOT_FOUND/);
});

test('world detail keeps the selected playable role and explicit empty defaults',async()=>{
 const {initialSessionSelection}=await import('../src/features/sessions/creation.ts');
 const world={openings:[{id:'start'}],characters:[{id:'first',player_selectable:true},{id:'chosen',player_selectable:true},{id:'npc'}],defaultPresetId:null,defaultReplyAssistPresetId:null,defaultApiModelConfigId:null};
 assert.deepEqual(initialSessionSelection(world,'chosen'),{opening:'start',character:'chosen',preset:'',replyPreset:null,model:''});
 assert.equal(initialSessionSelection(world).character,'first');
 assert.equal(initialSessionSelection(world,'npc').character,'');
 assert.equal(initialSessionSelection(world,'missing').character,'');
});

test('stage configuration uses an explicit isolated origin and keeps the management entry separate',async()=>{
 const {stageURL}=await import('../src/stage-url.ts');
 const {allowsEntry}=await import('../entry-policy.ts');
 const config={stage:{origin:'http://127.0.0.1:5177',entryPath:'/frame.html'},debug:false};
 const url=stageURL(config,'http://127.0.0.1:5176','nonce');
 assert.equal(url.origin,config.stage.origin);assert.equal(url.pathname,'/frame.html');
 assert.equal(url.searchParams.get('hostOrigin'),'http://127.0.0.1:5176');assert.equal(url.hash,'#nonce');
 assert.throws(()=>stageURL({...config,stage:{...config.stage,origin:'http://127.0.0.1:5176'}},'http://127.0.0.1:5176','nonce'));
 assert.throws(()=>stageURL(config,'https://web.test','nonce'));
 for(const path of ['/frame.html','/world-component.html']){assert.equal(allowsEntry(path,true),true);assert.equal(allowsEntry(path,false),false);}
 for(const path of ['/api','/api/v1/sessions','/index.html','/'])assert.equal(allowsEntry(path,true),false);
 assert.equal(allowsEntry('/assets/frame.js',true),true);
});

test('LAN world and session frames accept only their paired Web host',async()=>{
 const {localOrigin}=await import('../src/local-origin.ts');
 const {stageHostOrigin}=await import('../src/stage-frame-protocol.ts');
 const web='http://192.168.1.21:5176';
 const stage=localOrigin(web,5177);
 const url=worldPreviewURL(stage,web,'nonce');
 assert.equal(url.origin,'http://192.168.1.21:5177');
 assert.equal(stageHostOrigin(url.search,stage,localOrigin(stage,5176)),web);
 assert.equal(stageHostOrigin('?hostOrigin=http://192.168.1.22:5176',stage,localOrigin(stage,5176)),null);
});

test('isolated build includes both renderer documents while management builds only its own entry',async()=>{
 const {loadConfigFromFile}=await import('vite');
 const isolated=await loadConfigFromFile({command:'build',mode:'world-preview'});
 const management=await loadConfigFromFile({command:'build',mode:'production'});
 assert.ok(isolated&&management);
 for(const {config} of [isolated,management]){
  assert.equal(config.clearScreen,false);
  assert.equal(config.server.host,'0.0.0.0');
  assert.equal(config.preview.host,'0.0.0.0');
 }
 assert.equal(management.config.server.proxy['/api'].changeOrigin,false);
 assert.equal(isolated.config.preview.proxy,undefined);
 const entries=isolated.config.build.rollupOptions.input;
 assert.ok(entries.stage.endsWith('/frame.html'));assert.ok(entries.world.endsWith('/world-component.html'));
 assert.equal(isolated.config.server.proxy,undefined);
 assert.ok(management.config.build.rollupOptions.input.endsWith('/index.html'));
});

test('creation requires an explicit choice for multiple openings and never substitutes a missing selection',async()=>{
 const {initialSessionSelection}=await import('../src/features/sessions/creation.ts');
 const world={openings:[{id:'one'},{id:'two'}],characters:[{id:'player',player_selectable:true}],defaultPresetId:'preset',defaultReplyAssistPresetId:'reply',defaultApiModelConfigId:'model'};
 assert.equal(initialSessionSelection(world).opening,'');
 assert.deepEqual(initialSessionSelection(world,'player','two'),{opening:'two',character:'player',preset:'preset',replyPreset:'reply',model:'model'});
 assert.equal(initialSessionSelection(world,'player','missing').opening,'');
 assert.equal(initialSessionSelection({...world,openings:[]}).opening,'');
 assert.equal(initialSessionSelection({...world,defaultReplyAssistPresetId:null}).replyPreset,null);
 assert.equal(initialSessionSelection({...world,defaultReplyAssistPresetId:'different-reply'}).replyPreset,'different-reply');
});
