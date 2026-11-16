import {expect,it} from 'vitest';
import {openDatabase} from '../src/infrastructure/database/database.js';
import {seedWorld,fakeCredentials} from './fixtures/db-seed.js';
import {parseCard} from '../src/domain/world-card.js';
import {createApp} from '../src/app.js';
import {worldStateQueries,readWorldState} from '../../studio/src/features/worlds/world-component-protocol.js';

const source='export default function Component(){return null}';
const base={name:'World',characters:[{id:'p',name:'Player',player_selectable:true}],openings:[{id:'o',name:'Opening',content:'first <Badge/>'}]};
const card=(data:object)=>({spec:'world_card',spec_version:'0.1',data:{...base,...data}});
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
