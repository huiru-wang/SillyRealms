import {expect,it} from 'vitest';
import {openDatabase} from '../src/infrastructure/database/database.js';
import {defaultPreset,presetSchema} from '../src/domain/preset/schema.js';
import {createApp} from '../src/app.js';
import {runtimeFixture,textGateway} from './fixtures/runtime-v2.js';
import {fakeCredentials} from './fixtures/db-seed.js';
const request=(body:unknown,method='POST',etag?:string)=>({method,headers:{'content-type':'application/json',...(etag?{'If-Match':etag}:{})},body:JSON.stringify(body)});
it('stores exactly eight columns; import/export round trip prompts and validates fixed nodes',async()=>{
 const db=openDatabase(':memory:'),app=createApp(db,fakeCredentials);
 try{
  expect(db.prepare('PRAGMA table_info(presets)').all().map(r=>r.name)).toEqual(['id','name','description','model_parameters','context_strategy','config_json','created_at','updated_at']);
  const preset=defaultPreset();
  const imported=await app.request('/api/v1/presets/import',request(preset));expect(imported.status).toBe(201);
  const item=(await imported.json() as any).data.item;
  const exported=await (await app.request('/api/v1/presets/'+item.id+'/export')).json();
  expect(exported).toEqual({...preset,name:item.name});expect(presetSchema.safeParse(exported).success).toBe(true);
  expect((await app.request('/api/v1/presets/import',request({...preset,budget:{}}))).status).toBe(422);
  preset.config_json.nodes[0]!.enabled=false;
  expect((await app.request('/api/v1/presets/import',request(preset))).status).toBe(422);
 }finally{db.close();}
});
it('saves all node changes atomically with stale draft protection',async()=>{
 const db=openDatabase(':memory:'),app=createApp(db,fakeCredentials),path='/api/v1/presets/sr-default-preset';
 try{
  const item=(await (await app.request(path)).json() as any).data.item;
  const config=structuredClone(item.config_json);config.nodes.find((n:any)=>n.id==='worldState').enabled=false;
  expect((await app.request(path,request({config_json:config},'PATCH',item.etag))).status).toBe(200);
  expect((await app.request(path,request({name:'stale'},'PATCH',item.etag))).status).toBe(409);
  const current=(await (await app.request(path)).json() as any).data.item;
  expect(current.name).toBe(item.name);expect(current.config_json).toEqual(config);
  config.nodes[0].empty='forbidden';
  expect((await app.request(path,request({name:'must rollback',config_json:config},'PATCH',current.etag))).status).toBe(422);
  expect(db.prepare('SELECT name FROM presets').get()!.name).toBe(item.name);
 }finally{db.close();}
});
it('previews draft nodes with real sources without models or persistence',async()=>{
 let calls=0;const gateway=textGateway('unused'),stream=gateway.stream;gateway.stream=(...args)=>{calls++;return stream(...args);};
 const {db,preset}=runtimeFixture(gateway),app=createApp(db,fakeCredentials,gateway);
 try{
  const before=db.prepare('SELECT * FROM entries').all();
  const response=await app.request('/api/v1/presets/preview',request({preset,sessionId:'session',input:'preview input'}));
  expect(response.status).toBe(200);const result=(await response.json() as any).data;
  expect(result.preview.trace.at(-2).nodeId).toBe('worldState');expect(result.preview.activeRoots).toEqual(['score']);
  expect(JSON.stringify(result.preview.messages)).toContain('preview input');
  expect(calls).toBe(0);expect(db.prepare('SELECT * FROM entries').all()).toEqual(before);expect(db.prepare('SELECT count(*) n FROM run_preparations').get()!.n).toBe(0);
 }finally{db.close();}
});
