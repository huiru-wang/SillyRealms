import {migrateWorldComponents} from '../src/domain/world-components-migration.js';
import {serveStudio} from '../src/infrastructure/http/studio-assets.js';
import {createStageApp,serveWebConfig} from '../src/infrastructure/http/stage-assets.js';
import {fileURLToPath} from 'node:url';
/** Isolated integration server: memory DB, temporary world files, no real credentials or Provider. */
import {serve} from '@hono/node-server';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/infrastructure/database/database.js';
import {createApp} from '../src/app.js';
import {WorldFileStore} from '../src/infrastructure/world-files/world-file-store.js';
import {seedWorld,fakeCredentials} from './fixtures/db-seed.js';
import {tail} from './fixtures/runtime-v2.js';
import type {ModelGateway} from '../src/runtime/model/pi-gateway.js';
import type {Api,Model,AssistantMessageEvent} from '@earendil-works/pi-ai';
const directory=mkdtempSync(join(tmpdir(),'sr-studio-browser-'));
const db=openDatabase(':memory:');
const model:Model<Api>={id:'fake',name:'Offline test',provider:'fake',api:'openai-completions',baseUrl:'http://localhost',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:131072,maxTokens:8192};
const gateway:ModelGateway={resolve:()=>model,supportsDirect:()=>true,stream:(_model,_context,{signal})=>({async *[Symbol.asyncIterator](){
 const text='故事继续。旅人走过长街，看见远处的灯火。 <Badge/>'+tail();
 for(const delta of ['故事继续。','旅人走过长街，','看见远处的灯火。 <Badge/>',tail()]){if(signal.aborted)return;await new Promise(resolve=>setTimeout(resolve,350));yield {type:'text_delta',delta,contentIndex:0,partial:{} as never} as AssistantMessageEvent;}
 if(!signal.aborted)yield {type:'done',reason:'stop',message:{role:'assistant',content:[{type:'text',text}],api:'openai-completions',provider:'fake',model:'fake',usage:{input:120,output:30,cacheRead:0,cacheWrite:0,totalTokens:150,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()}} as AssistantMessageEvent;
}})};
const data=migrateWorldComponents({name:'灯火长街',lorebook:{entries:[{id:'lore-always',title:'长街的历史',content:'<p>沿着长街，记录过去的故事。</p>'.repeat(70),load:{mode:'always',anchor:'characterInfo',position:'after'}},{id:'lore-keyword',title:'港口与旅人',content:'港口的灯光在夜色中亮起。',load:{mode:'on_mention',keywords:['港口'],anchor:'userInput',position:'before'}},{id:'lore-disabled',title:'封存的档案',content:'档案暂不加载。',enabled:false,load:{mode:'always'}}]},description:'沿着长街，开始一段新的故事。',characters:[{id:'player',name:'旅人',description:'来到这里的旅人。',player_selectable:true}],openings:[{id:'opening',name:'灯火初上',content:'暮色落下，长街的灯火逐渐亮起。 <Badge/>'}],message_render:{rules:[{id:'badge',roles:['assistant'],pattern:'<Badge\\s*/>',replacement:{type:'component',component:'Badge'}}]},ui:{source:[{id:'Badge',component:"import React from 'react';export default function Badge(){return <strong data-component-badge>组件已加载</strong>}"}]}});
data.cover='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="56" height="66"><rect width="56" height="66" fill="#61516d"/><path d="M0 50L23 21L56 50V66H0Z" fill="#b6a2c8"/></svg>').toString('base64');
data.openings[0].content+='\n\n## 长街来信\n\n> 灯火照亮了归途。\n\n她说：“欢迎，**旅人**。” 他答："Good evening."\n\n- [x] 抵达长街\n- [ ] 继续探索\n\n- 街灯\n- 港口\n\n1. 观察四周\n2. 开始交谈';
data.characters.push(...Array.from({length:17},(_,index)=>({id:'resident-'+index,name:'长街居民 '+(index+1),description:'居住在长街的居民。',player_selectable:index===1})));
data.state={schema_version:1,scopes:{global:{weather:{type:'json',initial:{sky:'rainy'}}},session:{private:{type:'string',initial:'hidden'}},message:{private:{type:'string',initial:'hidden'}}}};
data.components.push({id:'ReadOnlyState',component:`import React from 'react';import * as SDK from '@sillyrealms/sdk';
export default function ReadOnlyState(){const api=SDK.useSRWorldStateAPI();const [status,setStatus]=React.useState('pending');React.useEffect(()=>{let active=true;(async()=>{const sky=await api.getState('weather.sky');const batch=await api.batchGetState([{path:'weather.sky',scope:'global'}]);let denied=0;for(const scope of ['session','message'])try{await api.getState('private',scope)}catch{denied++}let blocked=false;try{await fetch('/api/v1/worlds/browser-world')}catch{blocked=true}if(active)setStatus(sky==='rainy'&&batch[0]?.value==='rainy'&&denied===2&&blocked&&!api.updateState&&!api.subscribe&&!SDK.useSRSessionAPI&&!SDK.useSRSession&&!SDK.useSRState?'state-safe':'failed')})().catch(()=>{if(active)setStatus('failed')});return()=>{active=false}},[api]);return <p data-state-check={status}>{status}</p>}`});
const intro=data.components.find((item:any)=>item.id===data.description.component);
intro.component="import React from 'react';import ReadOnlyState from './ReadOnlyState';export default function Introduction(){return <section><p>沿着长街，开始一段新的故事。</p><ReadOnlyState/></section>}";
const preview=data.components.find((item:any)=>item.id===data.openings[0].component);
preview.component="import React from 'react';import ReadOnlyState from './ReadOnlyState';export default function OpeningPreview(){return <section data-opening-preview><h2>独立开局预览</h2><ReadOnlyState/><audio controls src='https://example.invalid/opening.mp3' preload='none'/><p>不使用消息正则</p></section>}";
data.components.push({id:'SecondPreview',component:"import React from 'react';export default function SecondPreview(){return <p data-second-preview>第二开局预览</p>}"});
data.openings.push({id:'second',name:'第二个开局',content:'第二段实际正文',type:'component',component:'SecondPreview'});
seedWorld(db,'broken-preview',{spec:'world_card',spec_version:'0.1',data:{...data,description:{type:'component',component:'BrokenPreview'},components:[...data.components,{id:'BrokenPreview',component:'export default function BrokenPreview( {'}]}});
seedWorld(db,'browser-world',{spec:'world_card',spec_version:'0.1',data});
seedWorld(db,'custom-world',{spec:'world_card',spec_version:'0.1',data:{...data,name:'自定义舞台',stage_component:'mainSection',components:[...data.components,{id:'StatusBar',component:"import React from 'react';export default function StatusBar(){return <h2 data-custom-status>独立状态舞台</h2>}"},{id:'mainSection',component:"import React from 'react';import StatusBar from './StatusBar';import {useSRSession} from '@sillyrealms/sdk';export default function Main(){const session=useSRSession();return <section><StatusBar/><button onClick={()=>session.setDraft('来自作者舞台')}>填入草稿</button></section>}"}]}});
seedWorld(db,'cache-world',{spec:'world_card',spec_version:'0.1',data:{...data,name:'图片缓存回归',stage_component:'CacheStage',components:[...data.components,{id:'CacheStage',component:`import React from 'react';import {SR} from '@sillyrealms/sdk';export default function CacheStage(){return <><img data-cache-image src={${JSON.stringify(process.env.SR_TEST_IMAGE_URL??'')}}/><SR.WorldStory/></>}`} ]}});
// Detail-only cache fixture: fresh component state on every mount, shared cacheable image.
const detailImage=JSON.stringify((process.env.SR_TEST_IMAGE_URL??'')+'?detail');
seedWorld(db,'preview-cache-world',{spec:'world_card',spec_version:'0.1',data:{...data,name:'详情缓存回归',description:{type:'component',component:'CacheIntro'},openings:[{id:'one',name:'第一开局',content:'第一段正文',type:'component',component:'CacheOpening1'},{id:'two',name:'第二开局',content:'第二段正文',type:'component',component:'CacheOpening2'}],components:[...data.components,
 {id:'CacheContent',component:`import React from 'react';import ReadOnlyState from './ReadOnlyState';export default function Content(){const [count,setCount]=React.useState(0);return <section><img data-preview-cache src={${detailImage}} width="64" height="64"/><button data-preview-count onClick={()=>setCount(count+1)}>{count}</button><audio data-preview-audio controls preload="none" src="https://example.invalid/preview.mp3"/><ReadOnlyState/></section>}`},
 ...['CacheIntro','CacheOpening1','CacheOpening2'].map(id=>({id,component:`import React from 'react';import Content from './CacheContent';export default function Preview(){return <div data-cache-entry="${id}"><Content/></div>}`})),
]}});
for(const [id,ui] of Object.entries({
 'missing-main':{source:[],main:'missing'},
 'broken-main':{main:'Broken',source:[{id:'Broken',component:'export default function Broken( {'}]},
 'old-sdk':{main:'Old',source:[{id:'Old',component:"import {SR} from '@sr/sdk';export default function Old(){return <SR.WorldStory/>}"}]},
 'broken-message':{source:[{id:'Badge',component:'export default function Badge( {'}]},
}))seedWorld(db,id,{spec:'world_card',spec_version:'0.1',data:{...data,name:id,stage_component:ui.main,components:[...data.components.filter((item:any)=>!ui.source.some(source=>source.id===item.id)),...ui.source]}});
db.prepare('UPDATE app_settings SET default_preset_id=?,default_api_model_config_id=? WHERE id=1').run('sr-default-preset','test-model');
const studioDir=fileURLToPath(new URL('../../studio/dist/',import.meta.url));
const stageServer=serve({fetch:createStageApp(studioDir).fetch,hostname:'127.0.0.1',port:0});
if(!stageServer.listening)await new Promise<void>((resolve,reject)=>{stageServer.once('listening',resolve);stageServer.once('error',reject);});
const stagePort=(stageServer.address() as {port:number}).port;
const lanTestHost=process.env.SR_TEST_LAN_HOST;
const allowedOrigins=new Set<string>();
const app=createApp(db,fakeCredentials,gateway,new WorldFileStore(directory),allowedOrigins,new Set([`http://127.0.0.1:${stagePort}`,...(lanTestHost?[`http://${lanTestHost}:${stagePort}`]:[])]));
serveWebConfig(app,{origin:null,port:stagePort,entryPath:'/frame.html'});
serveStudio(app,studioDir);
const manifest:Record<string,string>={};
for(const worldId of ['browser-world','custom-world','cache-world','missing-main','broken-main','old-sdk','broken-message']){
 const response=await app.request('/api/v1/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({worldId,openingId:'opening',userCharacterId:'player'})});
 const body=await response.json() as any;if(!body.success)throw Error(JSON.stringify(body));manifest[worldId]=body.data.item.id;
}
const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:Number(process.env.SR_TEST_PORT??0)},info=>{if(lanTestHost)allowedOrigins.add(`http://${lanTestHost}:${info.port}`);manifest.port=String(info.port);if(process.env.SR_TEST_MANIFEST)writeFileSync(process.env.SR_TEST_MANIFEST,JSON.stringify(manifest));console.log('Studio isolated API ready');});
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{
 void Promise.all([app.shutdown(),new Promise<void>(resolve=>server.close(()=>resolve())),new Promise<void>(resolve=>stageServer.close(()=>resolve()))]).then(()=>{
  db.close();rmSync(directory,{recursive:true,force:true});process.exit(0);
 });
});
