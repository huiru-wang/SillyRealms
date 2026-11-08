import { fakeCredentials, configureWorldModel } from './fixtures/db-seed.js';
import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {createApp} from '../src/app.js';
import {openDatabase} from '../src/infrastructure/database/database.js';
import {parseCard} from '../src/domain/world-card.js';
import {buildContext} from '../src/agent/context/prompt-builder.js';

const world=JSON.parse(readFileSync(new URL('./fixtures/world-card.json',import.meta.url),'utf8'));
const source="function Cover(){return null} export default {Cover}";
const rule={id:'cover',roles:['assistant'],pattern:'<Cover\\s*/>',flags:'g',replacement:{type:'component',component:'Cover'}};
const withRender=(message_render:unknown)=>({...world,data:{...world.data,message_render}});

it('preserves message rules and source through import and export',async()=>{
  const db=openDatabase(':memory:'),app=createApp(db);
  try {
    const message_render={rules:[rule,{id:'style',roles:['user'],pattern:'(hello)',replacement:{type:'html',content:'<b>$1</b>'}}],component_source:source};
    const form=new FormData();form.set('file',new File([JSON.stringify(withRender(message_render))],'world.json'));
    const response=await app.request('/api/v1/worlds/import',{method:'POST',body:form});expect(response.status).toBe(201);
    const body=await response.json() as {data:{item:{id:string}}};
    const exported=await (await app.request(`/api/v1/worlds/${body.data.item.id}/export`)).json() as {data:{message_render:unknown}};
    expect(exported.data.message_render).toEqual(message_render);
    expect(parseCard(world).data.message_render).toBeUndefined();
  } finally {db.close();}
});

it('rejects invalid rule definitions with paths',()=>{
  const invalid=[
    {data:{rules:[rule]} ,path:'component_source'},
    {data:{rules:[rule,rule],component_source:source},path:'rules[1].id'},
    {data:{rules:[{...rule,pattern:'['}],component_source:source},path:'rules[0].pattern'},
    {data:{rules:[{...rule,flags:'gg'}],component_source:source},path:'rules[0].flags'},
    {data:{rules:[{...rule,roles:['tool']}],component_source:source},path:'rules[0].roles'},
    {data:{rules:[{...rule,pattern:'x'.repeat(2001)}],component_source:source},path:'rules[0].pattern'},
  ];
  for(const {data,path} of invalid) expect(()=>parseCard(withRender(data))).toThrow(path);
});

it('accepts the documented self-contained WorldStory example',()=>{
  const example=JSON.parse(readFileSync(new URL('./fixtures/worldstory-card.json',import.meta.url),'utf8'));
  const card=parseCard(example);
  expect(card.data.message_render?.rules).toHaveLength(3);
  expect(card.data.openings[0]?.initial_state).toEqual({进度:{阶段:'初遇'},灵力:5});
});

it('initializes the opening state and keeps display rules out of narrative context',async()=>{
  const db=openDatabase(':memory:'),app=createApp(db,fakeCredentials);
  try {
    const example=JSON.parse(readFileSync(new URL('./fixtures/worldstory-card.json',import.meta.url),'utf8'));
    const form=new FormData();form.set('file',new File([JSON.stringify(example)],'world.json'));
    const imported=await (await app.request('/api/v1/worlds/import',{method:'POST',body:form})).json() as {data:{item:{id:string}}};
    configureWorldModel(db,imported.data.item.id);
    const created=await (await app.request('/api/v1/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({worldId:imported.data.item.id,openingId:'start',userCharacterId:'player'})})).json() as {data:{item:{id:string}}};
    const base=`/api/v1/sessions/${created.data.item.id}`;
    const snapshot=await (await app.request(`${base}/state`)).json() as {data:{global:Record<string,unknown>;session:Record<string,unknown>;message:Record<string,unknown>}};
    expect(snapshot.data.message).toEqual({进度:{阶段:'初遇'},灵力:5});
    const history=await (await app.request(`${base}/runs`)).json() as {data:{runs:Array<{messages:Array<{role:'user'|'assistant';text:string}>}>}};
    const messages=history.data.runs.flatMap(run=>run.messages);
    expect(messages[0]?.text).toBe('<Cover/>');
    const context=buildContext(example.data,[{id:'chatHistory',kind:'system',role:'auto',enabled:true}], 'player',snapshot.data,messages,'继续');
    expect(JSON.stringify(context.messages(messages))).toContain('<Cover/>');
    expect(JSON.stringify(context.messages(messages))).not.toContain('function Cover');
  } finally {db.close();}
});
