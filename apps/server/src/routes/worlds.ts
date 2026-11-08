import { ErrorCodes } from '../common/error-codes.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { z } from 'zod';
import { initialState } from '../domain/state/state.js';
import { CardError,parseCard,readWorld,storedError } from '../domain/world-card.js';
import { targetRoutes,tagNames,clearTags,importTags,transaction } from '../domain/tags.js';
export function worldRoutes(db: DatabaseSync, removeWorld: <T>(worldId:string, ids:()=>string[], remove:()=>T) => Promise<T> = async (_worldId, _ids, remove) => remove()): Hono {
  const app = new Hono();
  targetRoutes(app,db,'world');
  app.post('/import',async c=>{
    try {
      const file=(await c.req.formData()).get('file');
      if(!(file instanceof File)) throw new CardError('$','Expected JSON file');
      if(file.size>10*1024*1024) return c.json({error:{code:ErrorCodes.FILE_TOO_LARGE,path:'$',reason:'Maximum file size is 10 MiB'}},413);
      let raw;
      try {raw=JSON.parse(await file.text());} catch {throw new CardError('$','Invalid JSON');}
      const world=parseCard(raw);
      const tags=world.data.tags??[];
      delete world.data.tags;
      const now=Date.now(),id=randomUUID();
      transaction(db,()=>{
        db.prepare('INSERT INTO worlds(id,name,data_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,world.data.name,JSON.stringify(world),JSON.stringify(initialState(world.data.state,'global')),now,now);
        importTags(db,'world',id,tags);
      });
      world.data.tags=tagNames(db,'world',id);
      return c.json({item:{id,...world,presetId:null},warnings:[]},201);
    } catch(error) {
      const path=error instanceof CardError?error.path:'$',reason=error instanceof CardError?error.reason:'World import failed';
      return c.json({error:{code:ErrorCodes.INVALID_WORLD,path,reason,message:path+': '+reason}},422);
    }
  });
  app.patch('/:id',async c=>{
    const id=c.req.param('id');
    if(!db.prepare('SELECT id FROM worlds WHERE id=?').get(id)) return c.json({error:{code:ErrorCodes.WORLD_NOT_FOUND}},404);
    const parsed=z.object({presetId:z.string().min(1).nullable()}).strict().safeParse(await c.req.json().catch(()=>null));
    if(!parsed.success) return c.json({error:{code:ErrorCodes.INVALID_WORLD_PATCH}},422);
    const {presetId}=parsed.data;
    if(presetId && !db.prepare('SELECT 1 FROM presets WHERE id=?').get(presetId)) return c.json({error:{code:ErrorCodes.PRESET_NOT_FOUND}},422);
    db.prepare('UPDATE worlds SET preset_id=?,updated_at=? WHERE id=?').run(presetId,Date.now(),id);
    return c.json({ok:true});
  });
  app.delete('/:id', async c => {
    const id = c.req.param('id');
    if (!db.prepare('SELECT id FROM worlds WHERE id=?').get(id)) return c.json({ error: { code: ErrorCodes.WORLD_NOT_FOUND, message: 'World not found' } }, 404);
    try {
      await removeWorld(id,()=>db.prepare('SELECT id FROM sessions WHERE world_id=?').all(id).map(row=>String(row.id)),()=>{
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('DELETE FROM entries WHERE session_id IN (SELECT id FROM sessions WHERE world_id=?)').run(id);
          db.prepare('DELETE FROM sessions WHERE world_id=?').run(id);
          clearTags(db,'world',id);
          db.prepare('DELETE FROM worlds WHERE id=?').run(id);
          db.exec('COMMIT');
        } catch (err) { db.exec('ROLLBACK'); throw err; }
      });
      return c.json({ok:true});
    } catch { return c.json({ error: { code: ErrorCodes.WORLD_DELETE_FAILED, message: 'Could not delete world' } }, 500); }
  });
  for(const exporting of [true,false]) app.get(exporting?'/:id/export':'/:id',c=>{
    const id=c.req.param('id')!;
    const row=db.prepare('SELECT * FROM worlds WHERE id=?').get(id);
    if(!row) return c.json({error:{code:ErrorCodes.WORLD_NOT_FOUND}},404);
    try {
      const card=readWorld(row);
      card.data.tags=tagNames(db,'world',id);
      return exporting?c.json(card):c.json({item:{id,...card,presetId:row.preset_id,createdAt:row.created_at,updatedAt:row.updated_at},warnings:JSON.parse(String(row.warnings_json))});
    } catch(error) {return c.json({error:storedError(error)},422);}
  });
  return app;
}
