import { fakeCredentials, configureWorldModel, seedModel } from './fixtures/db-seed.js';
import { expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/infrastructure/database/database.js';
import {readFileSync} from 'node:fs';
const sample=JSON.parse(readFileSync(new URL('./fixtures/preset.json',import.meta.url),'utf8'));
import { buildContext } from '../src/agent/context/prompt-builder.js';

const json=(method:string, body:unknown)=>({method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const base={name:'Harbor',description:'<b>{{user}}</b> **原文**',characters:[{id:'p',name:'水手',player_selectable:true}],openings:[{id:'o',name:'港口',content:'{{user}} 到港',format:'html'}]};
function upload(data:unknown) {
  const body=new FormData();
  body.set('file',new File([JSON.stringify({spec:'world_card',spec_version:'0.1',data})],'test.json'));
  return {method:'POST',body};
}
it('imports text unchanged, strips unknown fields and rejects object descriptions atomically',async()=>{
  const db=openDatabase(':memory:'), app=createApp(db);
  try {
    const invalid=await app.request('/api/v1/worlds/import',upload({...base,description:{format:'html',content:'wrong'},tags:['unused']}));
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({success:false,errorCode:'INVALID_WORLD'});
    expect(db.prepare('SELECT COUNT(*) AS n FROM tags').get()?.n).toBe(0);
    const unsafe=await app.request('/api/v1/worlds/import',upload({...base,state:{schema_version:1,scopes:{message:{bad:JSON.parse('{"type":"json","initial":{"__proto__":1}}')}}}}));
    expect(unsafe.status).toBe(422);
    const extensions={source:{load:{mode:'unused'},regex_scripts:['archive']}};
    const res=await app.request('/api/v1/worlds/import',upload({...base,preset:sample,extensions,regex_scripts:['unused'],format:'html'}));
    const {data:{item}}=await res.json() as {data:{item:{id:string}}};
    const exported=await (await app.request('/api/v1/worlds/'+item.id+'/export')).json();
    expect(exported).toEqual({spec:'world_card',spec_version:'0.1',data:{...base,openings:[{id:'o',name:'港口',content:'{{user}} 到港'}],extensions,tags:[]}});
    expect(db.prepare('SELECT count(*) AS n FROM presets').get()?.n).toBe(1);
  } finally {db.close();}
});
it('filters tags, copies independent world defaults to sessions and protects referenced presets',async()=>{
  const db=openDatabase(':memory:'), app=createApp(db,fakeCredentials);
  const call=async(path:string,init?:RequestInit)=>{const res=await app.request('/api/v1'+path,init);const body=await res.json() as any;return {status:res.status,data:res.ok&&!path.endsWith('/export')?body.data:body};};
  try {
    const imported={...sample,name:'冒险',tags:['港口'],model_parameters:{temperature:0.4}};
    const {data:{item:p}}=await call('/presets/import',json('POST',imported));
    const {data:{item:q}}=await call('/presets/import',json('POST',imported));
    expect(q.name).toBe('冒险(1)');
    const {data:portable}=await call('/presets/'+p.id+'/export');
    expect(portable.model_parameters.temperature).toBe(0.4);
    expect(portable).not.toHaveProperty('api_model_config_id');
    expect((await call('/presets/import',json('POST',{...imported,api_model_config_id:'old'}))).status).toBe(422);
    const {data:{item:w}}=await call('/worlds/import',upload({...base,tags:['港口','航海']}));
    await call('/worlds/import',upload({...base,tags:['港口']}));
    const {data:{items:tags}}=await call('/tags?type=world');
    const ids=tags.map((t:{id:string})=>'tagId='+t.id).join('&');
    expect((await call('/worlds?'+ids+'&match=all&limit=1')).data.items.map((i:{id:string})=>i.id)).toEqual([w.id]);
    const page=(await call('/worlds?'+ids+'&match=any&limit=1')).data;
    const next=(await call('/worlds?'+ids+'&match=any&limit=1&cursor='+page.nextCursor)).data;
    expect(page.items[0].id).not.toBe(next.items[0].id);
    expect((await call('/presets?'+ids)).data.errorCode).toBe('TAG_TYPE_MISMATCH');
    expect((await call('/worlds?tagId=missing')).data.errorCode).toBe('TAG_NOT_FOUND');

    configureWorldModel(db,w.id);
    expect((await call('/worlds/'+w.id,json('PATCH',{defaultPresetId:p.id}))).status).toBe(200);
    const create=json('POST',{worldId:w.id,openingId:'o',userCharacterId:'p'});
    const first=(await call('/sessions',create)).data.item;
    expect(first.presetId).toBe(p.id);
    expect(first.apiModelConfigId).toBe('test-model');

    seedModel(db,'model-y');
    await call('/worlds/'+w.id,json('PATCH',{defaultPresetId:q.id,defaultApiModelConfigId:'model-y'}));
    const second=(await call('/sessions',create)).data.item;
    expect(second.presetId).toBe(q.id);
    expect(second.apiModelConfigId).toBe('model-y');
    expect((await call('/sessions/'+first.id)).data).toMatchObject({presetId:p.id,apiModelConfigId:'test-model'});

    const removal=await call('/presets/'+p.id,{method:'DELETE'});
    expect(removal.status).toBe(409);
    expect(removal.data.errorCode).toBe('CONFIG_IN_USE');
    const updated=await call('/sessions/'+first.id,json('PATCH',{presetId:q.id,apiModelConfigId:'model-y'}));
    expect(updated.status).toBe(200);
    expect((await call('/sessions/'+first.id)).data).toMatchObject({presetId:q.id,apiModelConfigId:'model-y'});
    expect((await call('/presets/'+p.id,{method:'DELETE'})).status).toBe(200);
    expect((await call('/worlds/'+w.id,json('PATCH',{defaultPresetId:'missing'}))).status).toBe(422);
    expect(db.prepare('SELECT count(*) AS n FROM sessions').get()?.n).toBe(2);
  } finally {db.close();}
});
it('renders author text once while preserving input, history and runtime state values',()=>{
  const views={global:{},session:{},message:{}};
  const context=buildContext({characters:[{id:'hero',name:'A$&',player_selectable:true,prompt:'{{user}} / {{char}}'}]},[
    {id:'personaInfo',kind:'system',role:'system',enabled:true},
    {id:'chatHistory',kind:'system',role:'auto',enabled:true},
    {id:'userInput',kind:'system',role:'user',enabled:true}
  ],'hero',views,[],'{{user}} now');
  expect(context.messages([{role:'user',text:'{{user}} before'}]).slice(1).map(m=>m.content)).toEqual(['A$& / {{char}}','{{user}} before','{{user}} now']);
  expect(context.render('summary {{user}}')).toBe('summary A$&');
});

it('rolls back imported worlds and tag names together and reports corrupt stored data without repairing it',async()=>{
  const db=openDatabase(':memory:'),app=createApp(db);
  try {
    db.exec("CREATE TRIGGER reject_assignment BEFORE INSERT ON tag_assignments BEGIN SELECT RAISE(ABORT,'fixture'); END");
    const failed=await app.request('/api/v1/worlds/import',upload({...base,tags:['new']}));
    expect(failed.ok).toBe(false);
    for(const table of ['tags','worlds','tag_assignments'])
      expect(db.prepare('SELECT count(*) AS n FROM '+table).get()?.n).toBe(0);
    db.exec('DROP TRIGGER reject_assignment');
    const {data:{item}}=await (await app.request('/api/v1/worlds/import',upload(base))).json() as {data:{item:{id:string}}};
    db.prepare('UPDATE worlds SET state=? WHERE id=?').run('{"extra":1}',item.id);
    const result=await app.request('/api/v1/worlds/'+item.id);
    expect(await result.json()).toMatchObject({success:false,errorCode:'WORLD_CORRUPT',errorMessage:expect.stringContaining('世界卡损坏'),data:{path:expect.any(String),reason:expect.any(String)}});
    expect(db.prepare('SELECT state FROM worlds WHERE id=?').get(item.id)?.state).toBe('{"extra":1}');
  } finally {db.close();}
});
it('round-trips the optional creator UI and validates V1 state writes',async()=>{
  const db=openDatabase(':memory:'),app=createApp(db,fakeCredentials);
  const source="import React from 'react'; export default function App(){ return <p>hello</p> }";
  const state={schema_version:1,scopes:{message:{hero:{type:'json',initial:{hp:10},description:'角色的生命值。'}}}};
  try {
    const imported=await app.request('/api/v1/worlds/import',upload({...base,state,ui:{type:'react',source}}));
    expect(imported.status).toBe(201);const {data:{item}}=await imported.json() as {data:{item:{id:string}}};
    configureWorldModel(db,item.id);
    const card=await (await app.request('/api/v1/worlds/'+item.id+'/export')).json() as {data:{ui:{source:string}}};expect(card.data.ui.source).toBe(source);
    const session=await (await app.request('/api/v1/sessions',json('POST',{worldId:item.id,openingId:'o',userCharacterId:'p'}))).json() as {data:{item:{id:string}}};
    const url='/api/v1/sessions/'+session.data.item.id+'/state';
    expect((await app.request(url,json('PATCH',{updates:[{scope:'message',path:'hero.hp',value:7}]}))).status).toBe(200);
    const result=await (await app.request(url)).json() as {data:{message:{hero:{hp:number}}}};expect(result.data.message.hero.hp).toBe(7);
    expect((await app.request(url,json('PATCH',{updates:[{scope:'message',path:'hero.missing.hp',value:99}]}))).status).toBe(200);
    expect(((await (await app.request(url)).json()) as {data:{message:{hero:{hp:number}}}}).data.message.hero.hp).toBe(7);
    expect((await app.request('/api/v1/worlds/import',upload({...base,ui:{type:'react',source:42}}))).status).toBe(422);
  } finally {db.close();}
});

it('lists presets independently of API model configuration',async()=>{
  const db=openDatabase(':memory:'),app=createApp(db);
  try {
    const create=async(name:string)=>{
      const response=await app.request('/api/v1/presets',json('POST',{...sample,name}));
      expect(response.status).toBe(201);
    };
    await create('冒险');await create('叙事');
    const response=await app.request('/api/v1/presets?limit=100');
    expect(response.status).toBe(200);
    const {data:{items}}=await response.json() as {data:{items:Array<{name:string;description:string|null}>}};
    expect(items.find(item=>item.name==='冒险')).toMatchObject({description:'独立的测试预设'});
    expect(items.find(item=>item.name==='叙事')).toBeDefined();
    expect(JSON.stringify(items)).not.toContain('modelId');
  } finally {db.close();}
});
