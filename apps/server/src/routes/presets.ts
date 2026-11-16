import {captureSources} from '../runtime/context/snapshot.js';
import {compileContext} from '../runtime/context/node-compiler.js';
import {RunStore} from '../runtime/persistence/run-store.js';
import {presetFingerprint} from '../runtime/config.js';
import {estimateContext} from '../runtime/context/compaction/estimator.js';
import { Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { presetSchema,defaultPreset } from '../domain/preset/schema.js';
import { decodePreset,insertPreset,updatePreset } from '../repositories/preset-repository.js';
import { transaction,targetRoutes,importTags,tagNames,clearTags } from '../domain/tags.js';
import { referenceCounts } from '../repositories/config-references.js';
import { ErrorCodes,normalizeError } from '../common/error-codes.js';
import { failure } from '../common/http-response.js';
export function presetRoutes(db:DatabaseSync):Hono {
 const app=new Hono();targetRoutes(app,db,'preset');
 const read=(id:string)=>db.prepare('SELECT * FROM presets WHERE id=?').get(id);
 const item=(id:string)=>({...decodePreset(read(id)!),tags:tagNames(db,'preset',id)});
 app.get('/default',c=>c.json(defaultPreset()));
 const create=async(c:import('hono').Context)=>{
  try{
   const raw=await c.req.json();const {tags=[],...body}=raw;
   const names=z.array(z.string().trim().min(1)).parse(tags),value=presetSchema.parse(body);
   const id=transaction(db,()=>{const base=value.name;for(let n=1;db.prepare('SELECT 1 FROM presets WHERE name=?').get(value.name);n++)value.name=base+'('+n+')';const id=insertPreset(db,value);importTags(db,'preset',id,names);return id;});
   return c.json({item:item(id)},201);
  }catch(e){return c.json(failure(normalizeError(e,ErrorCodes.INVALID_PRESET).errorCode),422);}
 };
 app.post('/',create);app.post('/import',create);
 app.post('/preview',async c=>{
  try{
   const request=z.object({preset:presetSchema,sessionId:z.string().min(1),input:z.string().max(100000)}).strict().parse(await c.req.json());
   const store=new RunStore(db),session=store.session(request.sessionId);
   if(!session)return c.json(failure(ErrorCodes.SESSION_NOT_FOUND),404);
   const sources=captureSources(store,request.sessionId,String(session.tip_entry_id),request.input);
   const boundary=sources.oldSummary?sources.history.findIndex(h=>h.id===sources.oldSummary!.coveredThroughEntryId):-1;
   const history=request.preset.context_strategy.strategy==='rolling_summary'&&sources.oldSummary&&boundary>=0?
     [{id:'summary',role:'assistant' as const,text:sources.oldSummary.text},...sources.history.slice(boundary+1)]:sources.history;
   const compiled=compileContext({...sources.snapshot,history,nodes:request.preset.config_json.nodes,presetHash:presetFingerprint(request.preset)});
   return c.json({preview:compiled,estimatedInputTokens:estimateContext({messages:compiled.messages}),contextStrategy:request.preset.context_strategy});
  }catch(e){return c.json(failure(normalizeError(e,ErrorCodes.INVALID_PRESET).errorCode),422);}
 });
 app.get('/:id/export',c=>{const row=read(c.req.param('id'));if(!row)return c.json(failure(ErrorCodes.PRESET_NOT_FOUND),404);const {id:_id,created_at:_c,updated_at:_u,etag:_e,...value}=decodePreset(row);return c.json(value);});
 app.get('/:id',c=>{const row=read(c.req.param('id'));if(!row)return c.json(failure(ErrorCodes.PRESET_NOT_FOUND),404);const value=item(String(row.id));c.header('ETag',value.etag);return c.json({item:value});});
 app.patch('/:id',async c=>{
  try{
   const raw=presetSchema.partial().strict().parse(await c.req.json()),id=c.req.param('id');
   return transaction(db,()=>{
    const row=read(id);if(!row)return c.json(failure(ErrorCodes.PRESET_NOT_FOUND),404);
    const current=decodePreset(row);
    if(c.req.header('If-Match')!==current.etag)return c.json(failure(ErrorCodes.PRESET_REVISION_CONFLICT),409);
    const {id:_id,created_at:_c,updated_at:_u,etag:_e,...base}=current;
    const next=presetSchema.parse({...base,...raw});
    if(db.prepare('SELECT 1 FROM presets WHERE name=? AND id<>?').get(next.name,id))return c.json(failure(ErrorCodes.PRESET_NAME_CONFLICT),409);
    updatePreset(db,id,next);return c.json({item:item(id)});
   });
  }catch(e){return c.json(failure(normalizeError(e,ErrorCodes.INVALID_PRESET).errorCode),422);}
 });
 app.delete('/:id',c=>{const id=c.req.param('id');if(!read(id))return c.json(failure(ErrorCodes.PRESET_NOT_FOUND),404);const refs=referenceCounts(db,'preset',id);if(refs.total)return c.json(failure(ErrorCodes.CONFIG_IN_USE,`当前有 ${refs.total} 处引用`,{counts:refs}),409);transaction(db,()=>{clearTags(db,'preset',id);db.prepare('DELETE FROM presets WHERE id=?').run(id);});return c.json({ok:true});});
 return app;
}
