import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { z } from 'zod';
const create = z.object({ type: z.string().min(1), name: z.string().trim().min(1) }).strict();
export function tagRoutes(db: DatabaseSync): Hono {
  const app = new Hono();
  app.get('/', c => { const type = c.req.query('type') ?? 'world'; return c.json({ items: db.prepare('SELECT * FROM tags WHERE type=? ORDER BY sort_order,name,id').all(type) }); });
  app.post('/', async c => {
    try { const body = create.parse(await c.req.json()); const id = randomUUID(); db.prepare('INSERT INTO tags(id,type,name,created_at) VALUES(?,?,?,?)').run(id, body.type, body.name, Date.now()); return c.json({ item: { id, ...body } }, 201); }
    catch { return c.json({ error: { code: 'INVALID_TAG', message: 'Invalid or duplicate tag' } }, 422); }
  });
  app.put('/order', async c => {
    try {
      const body = z.object({ type: z.string().min(1), orderedIds: z.array(z.string()) }).strict().parse(await c.req.json());
      const actual = db.prepare('SELECT id FROM tags WHERE type=?').all(body.type).map(row => String(row.id));
      if (new Set(body.orderedIds).size !== actual.length || body.orderedIds.length !== actual.length || body.orderedIds.some(id => !actual.includes(id))) throw new Error('Invalid tag order');
      db.exec('BEGIN IMMEDIATE');
      try { body.orderedIds.forEach((id, i) => db.prepare('UPDATE tags SET sort_order=? WHERE id=?').run(i, id)); db.exec('COMMIT'); }
      catch (err) { db.exec('ROLLBACK'); throw err; }
      return c.json({ ok: true });
    } catch { return c.json({ error: { code: 'INVALID_TAG_ORDER', message: 'Invalid tag order' } }, 422); }
  });
  const mutate = (id: string, name: string | null) => {
    const tag = db.prepare('SELECT * FROM tags WHERE id=?').get(id);
    if (!tag) return false;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (tag.type === 'world') for (const row of db.prepare('SELECT id,data_json FROM worlds').all()) {
        const world = JSON.parse(String(row.data_json));
        if (!Array.isArray(world.data.tags) || !world.data.tags.includes(tag.name)) continue;
        world.data.tags = [...new Set(world.data.tags.flatMap((t: string) => t === tag.name ? name === null ? [] : [name] : [t]))];
        db.prepare('UPDATE worlds SET data_json=?,updated_at=? WHERE id=?').run(JSON.stringify(world), Date.now(), String(row.id));
      }
      if (name === null) db.prepare('DELETE FROM tags WHERE id=?').run(id);
      else db.prepare('UPDATE tags SET name=? WHERE id=?').run(name, id);
      db.exec('COMMIT'); return true;
    } catch (err) { db.exec('ROLLBACK'); throw err; }
  };
  app.patch('/:id', async c => {
    try { const body = z.object({ name: z.string().trim().min(1) }).strict().parse(await c.req.json()); return mutate(c.req.param('id'), body.name) ? c.json({ ok:true }) : c.json({ error: { code:'TAG_NOT_FOUND', message:'Tag not found' } }, 404); }
    catch { return c.json({ error: { code:'INVALID_TAG', message:'Invalid or duplicate tag' } }, 422); }
  });
  app.delete('/:id', c => mutate(c.req.param('id'), null) ? c.json({ ok:true }) : c.json({ error:{code:'TAG_NOT_FOUND', message:'Tag not found'} }, 404));
  return app;
}
