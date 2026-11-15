import {expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/infrastructure/database/database.js';
import {seedSession,seedWorld,fakeCredentials} from './fixtures/db-seed.js';
import {readWorld} from '../src/repositories/world-repository.js';
import {parseCard} from '../src/domain/world-card.js';
import {createApp} from '../src/app.js';
import {worldStateQueries,readWorldState} from '../../studio/src/features/worlds/world-component-protocol.js';

const source='export default function Component(){return null}';
const base={name:'World',characters:[{id:'p',name:'Player',player_selectable:true}],openings:[{id:'o',name:'Opening',content:'first <Badge/>'}]};
const card=(data:object)=>({spec:'world_card',spec_version:'0.1',data:{...base,...data}});
function legacyDatabase(path:string,invalid=false){
 const db=openDatabase(path);seedWorld(db,'w');seedSession(db,'s','w',null,'p',null,'Preserve session','{}',1,2);
 db.exec("ALTER TABLE worlds DROP COLUMN components; ALTER TABLE worlds DROP COLUMN stage_component; ALTER TABLE worlds ADD COLUMN ui_json TEXT CHECK(ui_json IS NULL OR json_valid(ui_json)); PRAGMA user_version=4");
 const ui={source:[{id:'WorldIntroduction',component:source},{id:'CGImage',component:source}],main:'WorldIntroduction'};
 if(invalid)ui.source.push({id:'CGImage',component:source});
 db.prepare('UPDATE worlds SET description=?,ui_json=?,source_file_path=?,source_sha256=?,openings_json=?').run('<h1>Preserve prose</h1>',JSON.stringify(ui),'/original.json','original-hash',JSON.stringify(base.openings));
 return db;
}
it('migrates v4 to components and independent previews with a backup and no other data changes',()=>{
 const directory=mkdtempSync(join(tmpdir(),'sr-components-')),path=join(directory,'db.sqlite');
 try{
  const old=legacyDatabase(path),before=old.prepare('SELECT * FROM worlds').get()!;
  const tables=['sessions','entries','presets','api_model_configs','app_settings','tags','tag_assignments','run_preparations'];
  const rows=tables.map(table=>old.prepare('SELECT * FROM '+table).all());old.close();
  const db=openDatabase(path),after=db.prepare('SELECT * FROM worlds').get()!,world=readWorld(after);
  expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(5);
  expect(after).not.toHaveProperty('ui_json');expect(world.data.stage_component).toBe('WorldIntroduction');
  expect(world.data.description?.component).toBe('WorldIntroduction_');
  expect(world.data.components?.find(c=>c.id==='WorldIntroduction_')?.component).toContain('<h1>Preserve prose</h1>');
  expect(world.data.openings[0]).toMatchObject({...base.openings[0],type:'component',component:'OpeningPreview1'});
  expect(world.data.components?.find(c=>c.id==='OpeningPreview1')?.component).toContain('first <Badge/>');
  const stable=(row:Record<string,any>)=>Object.fromEntries(Object.entries(row).filter(([key])=>!['ui_json','components','stage_component','description','openings_json'].includes(key)));
  expect(stable(after)).toEqual(stable(before));tables.forEach((table,i)=>expect(db.prepare('SELECT * FROM '+table).all()).toEqual(rows[i]));db.close();
  const backups=readdirSync(directory).filter(name=>name.includes('.backup-v4-'));expect(backups).toHaveLength(1);
  const backup=new DatabaseSync(join(directory,backups[0]!),{readOnly:true});expect(backup.prepare('SELECT * FROM worlds').get()).toEqual(before);backup.close();
  const reopened=openDatabase(path);expect(reopened.prepare('SELECT * FROM worlds').get()).toEqual(after);reopened.close();
  expect(readdirSync(directory).filter(name=>name.includes('.backup-v4-'))).toHaveLength(1);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
it('rolls back the entire migration on invalid components',()=>{
 const directory=mkdtempSync(join(tmpdir(),'sr-components-invalid-')),path=join(directory,'db.sqlite');
 try{
  const old=legacyDatabase(path,true),before=old.prepare('SELECT * FROM worlds').get();old.close();
  expect(()=>openDatabase(path)).toThrow('Duplicate ID');
  const db=new DatabaseSync(path,{readOnly:true});expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(4);expect(db.prepare('SELECT * FROM worlds').get()).toEqual(before);db.close();
 }finally{rmSync(directory,{recursive:true,force:true});}
});
it('validates component references, paired opening fields and the canonical flat library',()=>{
 const components=[{id:'Intro',component:source}],description={type:'component',component:'Intro'};
 expect(parseCard(card({components,description,stage_component:'missing'})).data.stage_component).toBe('missing');
 for(const data of [{components,description:'old prose'},{ui:{source:components}},{components,description:{type:'component',component:'missing'}},{components,openings:[{...base.openings[0],type:'component'}]},{components,openings:[{...base.openings[0],type:'component',component:'missing'}]}])expect(()=>parseCard(card(data))).toThrow();
});
it('exposes only authoritative world state without sessions, schema, internal data or write routes',async()=>{
 const db=openDatabase(':memory:'),app=createApp(db,fakeCredentials);
 try{
  seedWorld(db,'w',card({state:{schema_version:1,scopes:{global:{weather:{type:'json',initial:{sky:'sunny'}}},session:{secret:{type:'string',initial:'session-only'}},message:{secret:{type:'string',initial:'message-only'}}}}}));
  db.prepare('UPDATE worlds SET state=? WHERE id=?').run('{"weather":{"sky":"rainy"}}','w');
  const response=await app.request('/api/v1/worlds/w/state');expect(response.status).toBe(200);expect((await response.json() as any).data).toEqual({global:{weather:{sky:'rainy'}}});
  expect((await app.request('/api/v1/worlds/missing/state')).status).toBe(404);
  expect((await app.request('/api/v1/worlds/w/state',{method:'PATCH',body:'{}',headers:{'content-type':'application/json'}})).status).toBe(404);
  expect((await app.request('/api/v1/worlds/w/state',{headers:{Origin:'null'}})).status).toBe(403);
  const created=await app.request('/api/v1/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({worldId:'w',openingId:'o',userCharacterId:'p'})});
  expect(created.status).toBe(201);const id=(await created.json() as any).data.item.id;
  const history=(await (await app.request('/api/v1/sessions/'+id+'/runs')).json() as any).data;
  expect(history.runs[0].messages[0]).toMatchObject({text:base.openings[0]!.content,origin:'opening'});
  expect(JSON.parse(String(db.prepare('SELECT payload FROM entries WHERE session_id=?').get(id)?.payload)).message.content).toEqual([{type:'text',text:base.openings[0]!.content}]);
 }finally{db.close();}
});
it('rejects forged Host requests independently of the readonly iframe facade',()=>{
 expect(worldStateQueries('world.state.read',{entries:[{path:'weather.sky'}]})).toEqual([{path:'weather.sky',scope:'global'}]);
 for(const method of ['session.history','session.send','state.write','state.read','subscribe','fetch'])expect(()=>worldStateQueries(method,{entries:[]})).toThrow('API_NOT_ALLOWED');
 for(const entry of [{path:'weather',scope:'session'},{path:'weather',scope:'message'},{path:'weather',value:'write'},{path:'__proto__.secret'},{path:''}])expect(()=>worldStateQueries('world.state.read',{entries:[entry]})).toThrow();
 expect(()=>worldStateQueries('world.state.read',{entries:Array(101).fill({path:'weather'})})).toThrow();
 expect(readWorldState({weather:{sky:'rainy'}},'weather.sky')).toBe('rainy');expect(readWorldState({},'toString')).toBeUndefined();
});
