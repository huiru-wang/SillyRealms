import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/infrastructure/database/database.js';

const card = { spec: 'world_card', spec_version: '0.1', data: { name: 'Test', tags: [' fantasy ', 'fantasy', 'other'], characters: [{ id: 'player', name: 'Player', player_selectable: true }], openings: [{ id: 'open', name: 'Start', content: 'Welcome' }] } };
describe('world imports and sessions', () => {
  it('deduplicates tags, creates opening without a preset and keeps invalid import atomic', async () => {
    const db = openDatabase(':memory:'); const app = createApp(db);
    const form = new FormData(); form.set('file', new File([JSON.stringify(card)], 'world.json', { type: 'application/json' }));
    const response = await app.request('/api/v1/worlds/import', { method: 'POST', body: form });
    expect(response.status).toBe(201);
    const result = await response.json() as { data: { item: { id: string } } };
    expect(db.prepare('SELECT name FROM tags ORDER BY name').all().map(row => row.name)).toEqual(['fantasy','other']);
    const create = await app.request('/api/v1/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ worldId: result.data.item.id, openingId: 'open', userCharacterId: 'player' }) });
    expect(create.status).toBe(201);
    const session = await create.json() as { data: { item: { id: string; presetId: string } } };
    expect(session.data.item.presetId).toBeNull();
    expect(db.prepare('SELECT role, run_id, state FROM entries WHERE session_id=?').get(session.data.item.id)).toMatchObject({ role: 'assistant', state: '[]' });
    const bad = new FormData(); bad.set('file', new File([JSON.stringify({ ...card, data: { ...card.data, tags: ['newtag', '  '] } })], 'bad.json'));
    expect((await app.request('/api/v1/worlds/import', { method: 'POST', body: bad })).status).toBe(422);
    expect(db.prepare('SELECT count(*) AS n FROM tags').get()?.n).toBe(2);
    db.close();
  });
});

it('reports an invalid lore load rule without executing world content', async () => {
  const db = openDatabase(':memory:'); const app = createApp(db);
  const invalid = { ...card, data: { ...card.data, lorebook: { entries: [{
    id: 'invalid', content: '<% throw new Error("should not execute") %>',
    load: { mode: 'on_mention', keywords: [] },
  }] } } };
  const form = new FormData();
  form.set('file', new File([JSON.stringify(invalid)], 'world.json'));
  const response = await app.request('/api/v1/worlds/import', { method:'POST', body:form });
  const result = await response.json() as {code:string;message:string};
  expect(response.status).toBe(422);
  expect(result.message).toContain('$.data.lorebook.entries[0].load.keywords');
  db.close();
});

it('rejects a session tip pointing into another session', async () => {
  const db=openDatabase(':memory:'), now=Date.now();
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?)').run('s1','w',null,'p','e2',null,'{}',now,now);
  db.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,branch_count,timestamp,payload,state,ext_data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('e2','s2',null,'r2',1,'message','assistant',0,now,JSON.stringify({message:{role:'assistant',content:'other'}}),'[]','{}');
  const response=await createApp(db).request('/api/v1/sessions/s1/history');
  expect(response.status).toBe(500);
  expect((await response.json() as {code:string}).code).toBe('INVALID_PARENT_CHAIN');
  db.close();
});

it('accepts the synthetic world and preset fixtures', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const db=openDatabase(':memory:'),app=createApp(db);
  const worldPath=fileURLToPath(new URL('./fixtures/world-card.json',import.meta.url));
  const presetPath=fileURLToPath(new URL('./fixtures/preset.json',import.meta.url));
  const form=new FormData();form.set('file',new File([readFileSync(worldPath)],'world.json'));
  expect((await app.request('/api/v1/worlds/import',{method:'POST',body:form})).status).toBe(201);
  expect((await app.request('/api/v1/presets',{method:'POST',headers:{'content-type':'application/json'},body:readFileSync(presetPath,'utf8')})).status).toBe(201);
  db.close();
});

it('renames and removes tags in every referencing world', async () => {
  const db=openDatabase(':memory:'),app=createApp(db);
  const form=new FormData(); form.set('file',new File([JSON.stringify(card)],'world.json'));
  const imported=await app.request('/api/v1/worlds/import',{method:'POST',body:form}); const world=(await imported.json() as {data:{item:{id:string}}}).data.item.id;
  const tag=db.prepare('SELECT id FROM tags WHERE name=?').get('fantasy')!;
  const before=db.prepare('SELECT data_json FROM worlds WHERE id=?').get(world)?.data_json;
  const update=await app.request(`/api/v1/tags/${tag.id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({name:'renamed'})});expect(update.status).toBe(200);
  expect(db.prepare('SELECT data_json FROM worlds WHERE id=?').get(world)?.data_json).toBe(before);
  expect((await (await app.request('/api/v1/worlds/'+world+'/export')).json() as {data:{tags:string[]}}).data.tags).toContain('renamed');
  expect((await app.request(`/api/v1/tags/${tag.id}`,{method:'DELETE'})).status).toBe(200);
  expect(db.prepare('SELECT data_json FROM worlds WHERE id=?').get(world)?.data_json).toBe(before);
  expect((await (await app.request('/api/v1/worlds/'+world+'/export')).json() as {data:{tags:string[]}}).data.tags).not.toContain('renamed');
  db.close();
});

it('paginates complete runs rather than splitting their entries', async () => {
  const db=openDatabase(':memory:'),now=Date.now();
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?)').run('s','w',null,'p','e4',null,'{}',now,now);
  const records=[['e1',null,'r0','assistant'],['e2','e1','r1','user'],['e3','e2','r1','assistant'],['e4','e3','r1','assistant']] as const;
  records.forEach(([id,parent,run,role],i)=>db.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,branch_count,timestamp,payload,state,ext_data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'s',parent,run,i+1,'message',role,0,now,JSON.stringify({message:{role,content:id}}),null,'{}'));
  const app=createApp(db);const first=await (await app.request('/api/v1/sessions/s/history?limit=1')).json() as {data:{runs:Array<{entries:unknown[]}>;hasMore:boolean;nextCursor:string}};
  expect(first.data.runs).toHaveLength(1);expect(first.data.runs[0]?.entries).toHaveLength(3);expect(first.data.hasMore).toBe(true);
  const next=await (await app.request(`/api/v1/sessions/s/history?limit=1&cursor=${first.data.nextCursor}`)).json() as {data:{runs:Array<{entries:unknown[]}>;hasMore:boolean}};
  expect(next.data.runs[0]?.entries).toHaveLength(1);expect(next.data.hasMore).toBe(false);db.close();
});
