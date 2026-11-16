import {expect,it} from 'vitest';
import {openDatabase} from '../src/infrastructure/database/database.js';
import {defaultPreset,presetSchema} from '../src/domain/preset/schema.js';
import {createApp} from '../src/app.js';
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

it('removes the session-content preview endpoint', async () => {
 const db = openDatabase(':memory:'), app = createApp(db, fakeCredentials);
 try {
  const before = db.prepare('SELECT * FROM presets').all();
  const response = await app.request('/api/v1/presets/preview',
   request({preset: defaultPreset(), sessionId: 'not-needed', input: 'preview input'}));
  expect(response.status).toBe(404);
  expect((await response.json() as any).errorCode).toBe('NOT_FOUND');
  expect(db.prepare('SELECT * FROM presets').all()).toEqual(before);
  expect(db.prepare('SELECT count(*) n FROM entries').get()!.n).toBe(0);
 } finally { db.close(); }
});

it('round trips edited built-in prompts and interleaved custom nodes without regrouping', async () => {
 const db = openDatabase(':memory:'), app = createApp(db, fakeCredentials);
 try {
  const preset = defaultPreset();
  preset.config_json.nodes = preset.config_json.nodes.flatMap((node, index) => [{
   id: 'before-' + index, name: 'Before ' + node.name, kind: 'text' as const,
   role: 'system' as const, enabled: true, prompt: '{{user}} / {{history.summary}}',
  }, { ...node, prompt: 'Edited ' + node.id + '\n' + node.prompt }]);
  preset.config_json.nodes.push({
   id: 'last', name: 'Last', kind: 'text', role: 'assistant', enabled: true, prompt: 'Final custom prompt',
  });
  const imported = await app.request('/api/v1/presets/import', request(preset));
  expect(imported.status).toBe(201);
  const item = (await imported.json() as any).data.item;
  const path = '/api/v1/presets/' + item.id;
  const read = (await (await app.request(path)).json() as any).data.item;
  expect(read.config_json).toEqual(preset.config_json);
  const config = structuredClone(read.config_json);
  const last = config.nodes.pop();
  config.nodes.splice(11, 0, last);
  const saved = await app.request(path, request({config_json: config}, 'PATCH', read.etag));
  expect(saved.status).toBe(200);
  const after = (await (await app.request(path)).json() as any).data.item;
  expect(after.config_json).toEqual(config);
  expect((await (await app.request(path + '/export')).json() as any).config_json).toEqual(config);
  expect(JSON.parse(String(db.prepare('SELECT config_json FROM presets WHERE id=?').get(item.id)!.config_json)))
   .toEqual(config);
 } finally { db.close(); }
});

it('returns template and order errors without changing the saved preset', async () => {
 const db = openDatabase(':memory:'), app = createApp(db, fakeCredentials);
 const path = '/api/v1/presets/sr-default-preset';
 try {
  const before = (await (await app.request(path)).json() as any).data.item;
  const invalid = structuredClone(before.config_json);
  invalid.nodes[0].prompt = '{{history.unknown}}';
  const rejected = await app.request(path, request({config_json: invalid}, 'PATCH', before.etag));
  expect(rejected.status).toBe(422);
  const error = await rejected.json() as any;
  expect(error.errorCode).toBe('INVALID_PRESET');
  expect(error.errorMessage).toContain('history.unknown');
  expect(error.errorMessage).toContain('nodes');
  const reordered = structuredClone(before.config_json);
  [reordered.nodes[0], reordered.nodes[1]] = [reordered.nodes[1], reordered.nodes[0]];
  expect((await app.request(path, request({config_json: reordered}, 'PATCH', before.etag))).status).toBe(422);
  expect((await (await app.request(path)).json() as any).data.item).toEqual(before);
 } finally { db.close(); }
});

it('serves immutable default templates independently of edits to the database default preset', async () => {
 const db = openDatabase(':memory:'), app = createApp(db, fakeCredentials);
 const path = '/api/v1/presets/sr-default-preset';
 try {
  const defaults = (await (await app.request('/api/v1/presets/default')).json() as any).data;
  const before = (await (await app.request(path)).json() as any).data.item;
  const config = structuredClone(before.config_json);
  config.nodes[0].prompt = 'My changed default';
  expect((await app.request(path, request({config_json: config}, 'PATCH', before.etag))).status).toBe(200);
  expect((await (await app.request('/api/v1/presets/default')).json() as any).data).toEqual(defaults);
  const saved = (await (await app.request(path)).json() as any).data.item;
  const restored = structuredClone(saved.config_json);
  restored.nodes[0].prompt = defaults.config_json.nodes.find((node: any) => node.id === 'main').prompt;
  expect((await app.request(path, request({config_json: restored}, 'PATCH', saved.etag))).status).toBe(200);
  expect((await (await app.request(path)).json() as any).data.item.config_json).toEqual(defaults.config_json);
 } finally { db.close(); }
});
