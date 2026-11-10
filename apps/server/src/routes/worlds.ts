import { failure } from '../common/http-response.js';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { z } from 'zod';
import { ErrorCodes } from '../common/error-codes.js';
import { CardError,parseCard } from '../domain/world-card.js';
import { worldFailure } from './world-failure.js';
import { targetRoutes,tagNames,clearTags,importTags,transaction } from '../domain/tags.js';
import { readWorld,WorldRepository } from '../repositories/world-repository.js';
import { WorldFileStore,testWorldDataDir,validateWorldSourceName } from '../infrastructure/world-files/world-file-store.js';

/** RFC 5987 preserves non-ASCII upload names in browser downloads. */
function downloadDisposition(name:string): string {
  const fallback=/^[\x20-\x7e]+$/.test(name)?name.replace(/["\\]/g,'_'):'world.json';
  const encoded=encodeURIComponent(name).replace(/['()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

const patch=z.object({
  defaultPresetId:z.string().min(1).nullable().optional(),
  defaultApiModelConfigId:z.string().min(1).nullable().optional(),
}).strict().refine(v=>Object.keys(v).length>0);

export function worldRoutes(
  db: DatabaseSync,
  removeWorld: <T>(worldId:string, ids:()=>string[], remove:()=>T) => Promise<T> = async (_worldId, _ids, remove) => remove(),
  files:WorldFileStore = new WorldFileStore(testWorldDataDir()),
): Hono {
  const app = new Hono();
  const worlds=new WorldRepository(db);
  targetRoutes(app,db,'world');

  app.post('/import',async c=>{
    let id:string|undefined;
    try {
      const file=(await c.req.formData()).get('file');
      if(!(file instanceof File)) throw new CardError('$','Expected JSON file');
      let originalName:string;
      try{originalName=validateWorldSourceName(file.name);}catch{throw new CardError('$.filename','Expected a safe JSON filename');}
      if(file.size>10*1024*1024) return c.json(failure(ErrorCodes.FILE_TOO_LARGE, '最大文件大小为 10 MiB', { path: '$' }),413);
      const rawBytes=new Uint8Array(await file.arrayBuffer());
      let raw:unknown;
      try {raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(rawBytes));}
      catch {throw new CardError('$','Invalid JSON');}
      const card=parseCard(raw);
      const tags=card.data.tags??[];
      delete card.data.tags;
      id=randomUUID();
      const saved=await files.save(id,rawBytes,originalName);
      const currentId=id;
      try {
        transaction(db,()=>{
          const defaults=db.prepare('SELECT default_preset_id,default_api_model_config_id FROM app_settings WHERE id=1').get()!;
          worlds.insert({
            id:currentId,card,sourcePath:saved.path,sourceHash:saved.sha256,sourceKind:'imported',
            presetId:defaults.default_preset_id as string|null,
            modelId:defaults.default_api_model_config_id as string|null,
            now:Date.now(),
          });
          importTags(db,'world',currentId,tags);
        });
      } catch (error) { await files.remove(currentId).catch(()=>{}); throw error; }
      card.data.tags=tagNames(db,'world',currentId);
      const row=worlds.get(currentId)!;
      return c.json({item:{id:currentId,...card,defaultPresetId:row.default_preset_id,defaultApiModelConfigId:row.default_api_model_config_id},warnings:[]},201);
    } catch(error) {
      const path=error instanceof CardError?error.path:'$',reason=error instanceof CardError?error.reason:'World import failed';
      return c.json(failure(ErrorCodes.INVALID_WORLD, `${path}: ${reason}`, { path, reason }),422);
    }
  });

  app.patch('/:id',async c=>{
    const id=c.req.param('id');
    const existing=worlds.get(id);
    if(!existing) return c.json(failure(ErrorCodes.WORLD_NOT_FOUND),404);
    const parsed=patch.safeParse(await c.req.json().catch(()=>null));
    if(!parsed.success) return c.json(failure(ErrorCodes.INVALID_WORLD_PATCH),422);
    const next={
      preset:parsed.data.defaultPresetId===undefined ? existing.default_preset_id : parsed.data.defaultPresetId,
      model:parsed.data.defaultApiModelConfigId===undefined ? existing.default_api_model_config_id : parsed.data.defaultApiModelConfigId,
    };
    if(next.preset && !db.prepare('SELECT 1 FROM presets WHERE id=?').get(next.preset))
      return c.json(failure(ErrorCodes.PRESET_NOT_FOUND),422);
    if(next.model && !db.prepare('SELECT 1 FROM api_model_configs WHERE id=?').get(next.model))
      return c.json(failure(ErrorCodes.API_MODEL_CONFIG_NOT_FOUND),422);
    db.prepare('UPDATE worlds SET default_preset_id=?,default_api_model_config_id=?,updated_at=? WHERE id=?')
      .run(next.preset,next.model,Date.now(),id);
    return c.json({ok:true,defaultPresetId:next.preset,defaultApiModelConfigId:next.model});
  });

  app.delete('/:id',async c=>{
    const id=c.req.param('id');
    if(!worlds.get(id)) return c.json(failure(ErrorCodes.WORLD_NOT_FOUND),404);
    try {
      await removeWorld(id,()=>db.prepare('SELECT id FROM sessions WHERE world_id=?').all(id).map(row=>String(row.id)),()=>{
        transaction(db,()=>{
          db.prepare('DELETE FROM entries WHERE session_id IN (SELECT id FROM sessions WHERE world_id=?)').run(id);
          db.prepare('DELETE FROM sessions WHERE world_id=?').run(id);
          clearTags(db,'world',id);
          db.prepare('DELETE FROM worlds WHERE id=?').run(id);
        });
      });
      await files.remove(id);
      return c.json({ok:true});
    } catch {return c.json(failure(ErrorCodes.WORLD_DELETE_FAILED),500);}
  });

  app.get('/:id/source',async c=>{
    const row=worlds.get(c.req.param('id'));
    if(!row) return c.json(failure(ErrorCodes.WORLD_NOT_FOUND),404);
    if(row.source_kind!=='imported') return c.json(failure(ErrorCodes.WORLD_SOURCE_NOT_FOUND),404);
    try {
      const bytes=await files.read(String(row.id),String(row.source_file_path));
      if (createHash('sha256').update(bytes).digest('hex') !== row.source_sha256)
        return c.json(failure(ErrorCodes.WORLD_CORRUPT, '源文件校验和不匹配'),422);
      return c.newResponse(new Blob([Uint8Array.from(bytes)]),200,{
        'Content-Type':'application/json; charset=utf-8',
        'Content-Disposition':downloadDisposition(files.sourceFilename(String(row.id),String(row.source_file_path))),
      });
    } catch {return c.json(failure(ErrorCodes.WORLD_SOURCE_NOT_FOUND),404);}
  });
  for(const exporting of [true,false]) app.get(exporting?'/:id/export':'/:id',c=>{
    const row=worlds.get(c.req.param('id'));
    if(!row) return c.json(failure(ErrorCodes.WORLD_NOT_FOUND),404);
    try {
      const card=readWorld(row);
      card.data.tags=tagNames(db,'world',String(row.id));
      if(exporting){
        const filename=row.source_kind==='imported' ? files.sourceFilename(String(row.id),String(row.source_file_path)) : (()=>{try{return validateWorldSourceName(card.data.name+'.json');}catch{return 'world.json';}})();
        c.header('Content-Disposition',downloadDisposition(filename));
        return c.json(card);
      }
      return c.json({
        item:{id:row.id,...card,defaultPresetId:row.default_preset_id,defaultApiModelConfigId:row.default_api_model_config_id,createdAt:row.created_at,updatedAt:row.updated_at},
        warnings:JSON.parse(String(row.warnings_json)),
      });
    } catch(error) {return c.json(worldFailure(error),422);}
  });
  return app;
}
