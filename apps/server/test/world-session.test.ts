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
    const result = await response.json() as { item: { id: string } };
    expect(db.prepare('SELECT name FROM tags ORDER BY name').all().map(row => row.name)).toEqual(['fantasy','other']);
    const create = await app.request('/api/v1/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ worldId: result.item.id, openingId: 'open', userCharacterId: 'player', presetId: 'missing' }) });
    expect(create.status).toBe(201);
    const session = await create.json() as { item: { id: string; presetId: string } };
    expect(session.item.presetId).toBe('missing');
    expect(db.prepare('SELECT role, run_id, state FROM entries WHERE session_id=?').get(session.item.id)).toMatchObject({ role: 'assistant', state: '[]' });
    const bad = new FormData(); bad.set('file', new File([JSON.stringify({ ...card, data: { ...card.data, tags: ['newtag', '  '] } })], 'bad.json'));
    expect((await app.request('/api/v1/worlds/import', { method: 'POST', body: bad })).status).toBe(422);
    expect(db.prepare('SELECT count(*) AS n FROM tags').get()?.n).toBe(2);
    db.close();
  });
});

it('reports the invalid rule in the provided example without executing its contents', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const db = openDatabase(':memory:'); const app = createApp(db);
  const form = new FormData();
  form.set('file', new File([readFileSync(fileURLToPath(new URL('../../../docs/data-formats/world-card.json', import.meta.url)))], 'world.json'));
  const response = await app.request('/api/v1/worlds/import', { method:'POST', body:form });
  const result = await response.json() as {error?:{code:string;message:string}; warnings?:Array<{code:string}>};
  expect(response.status).toBe(422);
  expect(result.error?.message).toContain('$.data.lorebook.entries[5].load.keywords');
  db.close();
});

it('rejects a session tip pointing into another session', async () => {
  const db=openDatabase(':memory:'), now=Date.now();
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?)').run('s1','w',null,'p','e2',null,'{}',now,now);
  db.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('e2','s2',null,'r2',1,'message','assistant',0,now,JSON.stringify({message:{role:'assistant',content:'other'}}),'[]','{}');
  const response=await createApp(db).request('/api/v1/sessions/s1/history');
  expect(response.status).toBe(500);
  expect((await response.json() as {error:{code:string}}).error.code).toBe('INVALID_PARENT_CHAIN');
  db.close();
});

it('accepts the synthetic MVP world and preset examples', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const db=openDatabase(':memory:'),app=createApp(db);
  const worldPath=fileURLToPath(new URL('../../../docs/data-formats/mvp-world-card.json',import.meta.url));
  const presetPath=fileURLToPath(new URL('../../../docs/data-formats/mvp-preset.json',import.meta.url));
  const form=new FormData();form.set('file',new File([readFileSync(worldPath)],'world.json'));
  expect((await app.request('/api/v1/worlds/import',{method:'POST',body:form})).status).toBe(201);
  expect((await app.request('/api/v1/presets',{method:'POST',headers:{'content-type':'application/json'},body:readFileSync(presetPath,'utf8')})).status).toBe(201);
  db.close();
});

it('renames and removes tags in every referencing world', async () => {
  const db=openDatabase(':memory:'),app=createApp(db);
  const form=new FormData(); form.set('file',new File([JSON.stringify(card)],'world.json'));
  const imported=await app.request('/api/v1/worlds/import',{method:'POST',body:form}); const world=(await imported.json() as {item:{id:string}}).item.id;
  const tag=db.prepare('SELECT id FROM tags WHERE name=?').get('fantasy')!;
  const update=await app.request(`/api/v1/tags/${tag.id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({name:'renamed'})});expect(update.status).toBe(200);
  expect(JSON.parse(String(db.prepare('SELECT data_json FROM worlds WHERE id=?').get(world)?.data_json)).data.tags).toContain('renamed');
  expect((await app.request(`/api/v1/tags/${tag.id}`,{method:'DELETE'})).status).toBe(200);
  expect(JSON.parse(String(db.prepare('SELECT data_json FROM worlds WHERE id=?').get(world)?.data_json)).data.tags).not.toContain('renamed');
  db.close();
});

it('paginates complete runs rather than splitting their entries', async () => {
  const db=openDatabase(':memory:'),now=Date.now();
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?)').run('s','w',null,'p','e4',null,'{}',now,now);
  const records=[['e1',null,'r0','assistant'],['e2','e1','r1','user'],['e3','e2','r1','assistant'],['e4','e3','r1','assistant']] as const;
  records.forEach(([id,parent,run,role],i)=>db.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'s',parent,run,i+1,'message',role,0,now,JSON.stringify({message:{role,content:id}}),null,'{}'));
  const app=createApp(db);const first=await (await app.request('/api/v1/sessions/s/history?limit=1')).json() as {runs:Array<{entries:unknown[]}>;hasMore:boolean;nextCursor:string};
  expect(first.runs).toHaveLength(1);expect(first.runs[0]?.entries).toHaveLength(3);expect(first.hasMore).toBe(true);
  const next=await (await app.request(`/api/v1/sessions/s/history?limit=1&cursor=${first.nextCursor}`)).json() as {runs:Array<{entries:unknown[]}>;hasMore:boolean};
  expect(next.runs[0]?.entries).toHaveLength(1);expect(next.hasMore).toBe(false);db.close();
});
