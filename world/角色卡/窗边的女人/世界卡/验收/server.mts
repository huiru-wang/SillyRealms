/** 只使用内存 SQLite、临时附件目录和离线 Gateway。不得改用用户数据库或真实 Provider。 */
import {createRequire} from 'node:module';
import {readFileSync,readdirSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import {openDatabase} from '../../../../../apps/server/src/infrastructure/database/database.ts';
import {createApp} from '../../../../../apps/server/src/app.ts';
import {WorldFileStore} from '../../../../../apps/server/src/infrastructure/world-files/world-file-store.ts';
import {seedModel,fakeCredentials} from '../../../../../apps/server/test/fixtures/db-seed.ts';
import {serveStudio} from '../../../../../apps/server/src/infrastructure/http/studio-assets.ts';
import {parseCard} from '../../../../../apps/server/src/domain/world-card.ts';
import {moduleGraph} from '../../../../../packages/sr-ui-compiler/src/modules.ts';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../../../../../'),cards=resolve(here,'..');
const require=createRequire(join(root,'apps/server/package.json'));
const {serve}=require('@hono/node-server');
const db=openDatabase(':memory:'),temporary=mkdtempSync(join(tmpdir(),'sr-window-card-'));
const model={id:'fake',name:'Offline only',provider:'fake',api:'openai-completions',baseUrl:'http://127.0.0.1',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:131072,maxTokens:8192};
const payloadChecks:any[]=[];
const gateway={resolve:()=>model,supportsDirect:()=>true,toolVerified:()=>true,stream:(_model:any,context:any,{signal}:any)=>({async *[Symbol.asyncIterator](){
 const serialized=JSON.stringify(context);
 assert(!context.tools,'Direct must not register tools');assert(!serialized.includes('data:image/'),'assets leaked into model context');
 for(const keyword of ['【单人改编主持规约】','【主持人封存底稿','【囚鸽的私密角色本】','【梦秋雪的私密角色本】','【斯文男人的私密角色本】','【无常的私密角色本】','【普罗米修斯的私密角色本】','【黑弥撒的私密角色本】','media-blood'])assert(serialized.includes(keyword),'Missing '+keyword);
 assert(!serialized.includes('邓爱欣的大学好友，刚从加拿大回到宁河城。她不常发言'),'display description injected');
 const atRules=serialized.indexOf('【单人改编主持规约】'),atCase=serialized.indexOf('2016 年 2 月 1 日，沉寂'),atMap=serialized.indexOf('原地图是环线示意图'),atTruth=serialized.indexOf('【主持人封存底稿'),atClues=serialized.indexOf('仅供主持按阶段和获取权限发放');
 assert(atRules<atCase&&atCase<atMap&&atMap<atTruth&&atTruth<atClues,'Lore order mismatch');
 const hard=serialized.includes('困难难度**');
 // 固定合成输出仅验证管线与图像显示，绝不代表模型完成了推理或主持配额。
 const text='版主：这是一轮离线管线验收。已公开的记录会在提交后显示。';
 const raw=text+'<sr_extensions><state_update>'+JSON.stringify([{path:'publicClues',value:['30',hard?'08-hard':'08']},{path:'notes',value:['假设：窗边的人影是否能证明当时仍然活着？']}])+'</state_update><action_suggestions>'+JSON.stringify(['核对目击时间','查看地图','继续讨论'])+'</action_suggestions></sr_extensions>';
 payloadChecks.push({characters:6,loreEntries:5,toolFree:true,contextChars:serialized.length,imagesExcluded:true,difficulty:hard?'hard':'standard'});
 for(const delta of [text,raw.slice(text.length)]){if(signal.aborted)return;await new Promise(r=>setTimeout(r,100));yield {type:'text_delta',delta,contentIndex:0,partial:{}};}
 if(!signal.aborted)yield {type:'done',reason:'stop',message:{role:'assistant',content:[{type:'text',text:raw}],api:'openai-completions',provider:'fake',model:'fake',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()}};
}})};
seedModel(db);
const preset=JSON.parse(String(db.prepare('SELECT config_json FROM presets WHERE id=?').get('sr-default-preset')!.config_json));
preset.budget={strategy:'rolling_summary',max_context_tokens:65536,max_output_tokens:4096};
preset.capabilities={state_update:{enabled:true,prompt:''},action_suggestions:{enabled:true,count:3,prompt:''}};
db.prepare('UPDATE presets SET config_json=? WHERE id=?').run(JSON.stringify(preset),'sr-default-preset');
db.prepare('UPDATE app_settings SET default_preset_id=?,default_api_model_config_id=? WHERE id=1').run('sr-default-preset','test-model');
const app=createApp(db,fakeCredentials,gateway as any,new WorldFileStore(temporary));
const manifest:any={worlds:{},sessions:{},checks:[],payloadChecks};
app.get('/window-test-manifest',c=>c.json(manifest));
serveStudio(app,join(root,'apps/studio/dist'));
for(const name of readdirSync(cards).filter(x=>x.startsWith('窗边的女人-')&&x.endsWith('.json'))){
 const raw=readFileSync(join(cards,name)),card=parseCard(JSON.parse(raw.toString()));moduleGraph(card.data.components!);assert(raw.byteLength<10*1024*1024);
 const selected=card.data.characters.filter(x=>x.player_selectable);assert.equal(selected.length,1);assert.equal(card.data.characters[0]?.id,selected[0]?.id);
 const form=new FormData();form.set('file',new File([raw],name,{type:'application/json'}));
 const imported=await app.request('/api/v1/worlds/import',{method:'POST',body:form});assert.equal(imported.status,201,await imported.clone().text());const world=(await imported.json() as any).data.item;
 const exported=await(await app.request('/api/v1/worlds/'+world.id+'/export')).json() as any;
 assert.deepEqual(exported.data.characters,card.data.characters);assert.deepEqual(exported.data.openings,card.data.openings);assert.deepEqual(exported.data.components,card.data.components);
 manifest.worlds[selected[0]!.id]=world.id;
 for(const opening of card.data.openings){
  const res=await app.request('/api/v1/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({worldId:world.id,openingId:opening.id,userCharacterId:selected[0]!.id})});assert.equal(res.status,201,await res.clone().text());const session=(await res.json() as any).data.item;
  const row=db.prepare('SELECT state,payload FROM entries WHERE id=(SELECT tip_entry_id FROM sessions WHERE id=?)').get(session.id)!;
  const state=Object.fromEntries(JSON.parse(String(row.state)).map((x:any)=>[x.key,x.value]));assert.deepEqual(state,opening.initial_state);
  assert.equal(JSON.parse(String(row.payload)).message.content[0].text,opening.content);
  manifest.sessions[selected[0]!.id+'-'+opening.id]=session.id;
 }
 manifest.checks.push({file:name,bytes:raw.byteLength,parseCard:true,moduleGraph:true,importExport:true,openings:2,initialStates:true});
}
const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0},(info:any)=>{manifest.port=info.port;writeFileSync(join(here,'manifest.json'),JSON.stringify(manifest,null,2));console.log('PASS: six imports, twelve openings, round trips, exact initial state; ready '+info.port)});
for(const sig of ['SIGINT','SIGTERM'] as const)process.once(sig,()=>server.close(()=>{writeFileSync(join(here,'runtime-results.json'),JSON.stringify(manifest,null,2));db.close();rmSync(temporary,{recursive:true,force:true});process.exit(0)}));
