import { failure } from '../common/http-response.js';
import { ErrorCodes } from '../common/error-codes.js';
import { addTag,tagType } from '../domain/tags.js';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { z } from 'zod';
const create = z.object({ type: tagType, name: z.string().trim().min(1) }).strict();
export function tagRoutes(db: DatabaseSync): Hono {
  const app = new Hono();
  app.get('/', c => { const type=c.req.query('type'); if(!tagType.safeParse(type).success || !type) return c.json(failure(ErrorCodes.INVALID_TAG_TYPE),422); return c.json({ items: db.prepare('SELECT * FROM tags WHERE type=? ORDER BY sort_order,name,id').all(type) }); });
  app.post('/', async c => {
    try { const body = create.parse(await c.req.json()); const id=addTag(db,body.type,body.name); return c.json({ item: { id, ...body } }, 201); }
    catch { return c.json(failure(ErrorCodes.INVALID_TAG),422); }
  });
  app.put('/order', async c => {
    try {
      const body = z.object({ type: tagType, orderedIds: z.array(z.string()) }).strict().parse(await c.req.json());
      const actual = db.prepare('SELECT id FROM tags WHERE type=?').all(body.type).map(row => String(row.id));
      if (new Set(body.orderedIds).size !== actual.length || body.orderedIds.length !== actual.length || body.orderedIds.some(id => !actual.includes(id))) throw new Error('Invalid tag order');
      db.exec('BEGIN IMMEDIATE');
      try { body.orderedIds.forEach((id, i) => db.prepare('UPDATE tags SET sort_order=?,updated_at=? WHERE id=?').run(i,Date.now(),id)); db.exec('COMMIT'); }
      catch (err) { db.exec('ROLLBACK'); throw err; }
      return c.json({ ok: true });
    } catch { return c.json(failure(ErrorCodes.INVALID_TAG_ORDER),422); }
  });
  const mutate = (id: string, name: string | null) => {
    const tag = db.prepare('SELECT * FROM tags WHERE id=?').get(id);
    if (!tag) return false;
    db.exec('BEGIN IMMEDIATE');
    try {
      if(name===null) db.prepare('DELETE FROM tag_assignments WHERE tag_id=?').run(id);
      if (name === null) db.prepare('DELETE FROM tags WHERE id=?').run(id);
      else db.prepare('UPDATE tags SET name=?,updated_at=? WHERE id=?').run(name,Date.now(),id);
      db.exec('COMMIT'); return true;
    } catch (err) { db.exec('ROLLBACK'); throw err; }
  };
  app.patch('/:id', async c => {
    try { const body = z.object({ name: z.string().trim().min(1) }).strict().parse(await c.req.json()); return mutate(c.req.param('id'), body.name) ? c.json({ ok:true }) : c.json(failure(ErrorCodes.TAG_NOT_FOUND),404); }
    catch { return c.json(failure(ErrorCodes.INVALID_TAG),422); }
  });
  app.delete('/:id', c => mutate(c.req.param('id'), null) ? c.json({ ok:true }) : c.json(failure(ErrorCodes.TAG_NOT_FOUND),404));
  return app;
}
