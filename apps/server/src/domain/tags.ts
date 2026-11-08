import { ErrorCodes } from '../common/error-codes.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import type { Context, Hono } from 'hono';

export const tagType = z.enum(['world', 'preset']);
type Kind = z.infer<typeof tagType>;
const table = {world:'worlds', preset:'presets'} as const;
export function transaction<T>(db:DatabaseSync, work:()=>T):T {
  db.exec('BEGIN IMMEDIATE');
  try { const value=work(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function addTag(db:DatabaseSync,type:Kind,name:string) {
  const now=Date.now(), id=randomUUID();
  db.prepare('INSERT INTO tags(id,type,name,sort_order,created_at,updated_at) SELECT ?,?,?,coalesce(max(sort_order),-1)+1,?,? FROM tags WHERE type=?').run(id,type,name,now,now,type);
  return id;
}
export function tagNames(db:DatabaseSync,type:Kind,id:string) {
  return db.prepare('SELECT t.name FROM tags t JOIN tag_assignments a ON a.tag_id=t.id WHERE a.target_id=? AND t.type=? ORDER BY t.sort_order,t.name,t.id').all(id,type).map(r=>String(r.name));
}
function attach(db:DatabaseSync,tag:string,target:string) {
  const now=Date.now();
  db.prepare('INSERT INTO tag_assignments(id,tag_id,target_id,created_at,updated_at) VALUES(?,?,?,?,?)').run(randomUUID(),tag,target,now,now);
}
export function importTags(db:DatabaseSync,type:Kind,id:string,names:string[]) {
  for (const name of new Set(names)) {
    const found=db.prepare('SELECT id FROM tags WHERE type=? AND name=?').get(type,name);
    attach(db,found ? String(found.id) : addTag(db,type,name),id);
  }
}
export function clearTags(db:DatabaseSync,type:Kind,id:string) {
  db.prepare('DELETE FROM tag_assignments WHERE target_id=? AND tag_id IN (SELECT id FROM tags WHERE type=?)').run(id,type);
}
function validateIds(db:DatabaseSync,type:Kind,ids:string[]) {
  const read=db.prepare('SELECT type FROM tags WHERE id=?');
  for (const id of ids) {
    const row=read.get(id);
    if (!row || row.type!==type) throw new Error(row?'TAG_TYPE_MISMATCH':'TAG_NOT_FOUND',{cause:id});
  }
}
function failure(c:Context,error:unknown,fallback:string) {
  const known=error instanceof Error && ['TAG_NOT_FOUND','TAG_TYPE_MISMATCH','INVALID_CURSOR','INVALID_MATCH'].includes(error.message);
  return c.json({error:{code:known?error.message:fallback,...(known && error.cause ? {id:error.cause}:{})}},422);
}
export function targetRoutes(app:Hono,db:DatabaseSync,type:Kind) {
  const target=table[type];
  app.put('/:id/tags',async c=>{
    const id=c.req.param('id');
    try {
      const body=z.object({tagIds:z.array(z.string().min(1))}).strict().parse(await c.req.json());
      if (!db.prepare('SELECT 1 FROM '+target+' WHERE id=?').get(id)) return c.json({error:{code:type.toUpperCase()+'_NOT_FOUND'}},404);
      transaction(db,()=>{
        const ids=[...new Set(body.tagIds)];
        validateIds(db,type,ids);
        const old=new Set(db.prepare('SELECT tag_id FROM tag_assignments JOIN tags ON tags.id=tag_id WHERE target_id=? AND type=?').all(id,type).map(r=>String(r.tag_id)));
        const added=ids.filter(k=>!old.has(k)), removed=[...old].filter(k=>!ids.includes(k));
        for(const k of removed) db.prepare('DELETE FROM tag_assignments WHERE tag_id=? AND target_id=?').run(k,id);
        for(const k of added) attach(db,k,id);
        if(added.length || removed.length) db.prepare('UPDATE '+target+' SET updated_at=? WHERE id=?').run(Date.now(),id);
      });
      return c.json({ok:true});
    } catch(error) {return failure(c,error,'INVALID_TAGS');}
  });
  app.get('/',c=>{
    try {
      const ids=[...new Set(c.req.queries('tagId')??[])].sort(), match=c.req.query('match')??'all';
      const query=c.req.query('query')??'', limit=Number(c.req.query('limit')??20);
      if(!['all','any'].includes(match)) throw new Error(ErrorCodes.INVALID_MATCH);
      if(!Number.isInteger(limit)||limit<1||limit>100) throw new Error(ErrorCodes.INVALID_CURSOR);
      validateIds(db,type,ids);
      const column=type==='world'?'updated_at':'created_at', dir=type==='world'?'DESC':'ASC';
      const where=['instr(name,?)>0'], args:SQLInputValue[]=[query];
      if(ids.length) {
        where.push('id IN (SELECT target_id FROM tag_assignments WHERE tag_id IN ('+ids.map(()=>'?').join(',')+') GROUP BY target_id'+(match==='all'?' HAVING count(*)=?':'')+')');
        args.push(...ids); if(match==='all') args.push(ids.length);
      }
      const signature=JSON.stringify([type,query,ids,match]);
      const cursor=c.req.query('cursor');
      if(cursor!==undefined) {
        let key;
        try { key=JSON.parse(Buffer.from(cursor,'base64url').toString()); } catch {throw new Error(ErrorCodes.INVALID_CURSOR);}
        if(key?.signature!==signature || !Number.isSafeInteger(key.time) || typeof key.id!=='string') throw new Error(ErrorCodes.INVALID_CURSOR);
        where.push('('+column+',id) '+(dir==='ASC'?'>':'<')+' (?,?)'); args.push(key.time,key.id);
      }
      const rows=db.prepare('SELECT id,name,created_at,updated_at FROM '+target+' WHERE '+where.join(' AND ')+' ORDER BY '+column+' '+dir+',id '+dir+' LIMIT ?').all(...args,limit+1);
      const items=rows.slice(0,limit), last=items.at(-1), hasMore=rows.length>limit;
      const selectedIds=items.map(r=>String(r.id));
      const marks=selectedIds.map(()=>'?').join(',');
      const tags=selectedIds.length?db.prepare('SELECT a.target_id,t.id,t.name FROM tag_assignments a JOIN tags t ON t.id=a.tag_id WHERE t.type=? AND a.target_id IN ('+marks+') ORDER BY t.sort_order,t.id').all(type,...selectedIds):[];
      const extras=selectedIds.length?db.prepare(type==='world'?'SELECT w.id,w.cover,w.default_preset_id,w.default_api_model_config_id,(SELECT count(*) FROM sessions s WHERE s.world_id=w.id) AS session_count FROM worlds w WHERE w.id IN ('+marks+')':'SELECT p.id,p.config_json FROM presets p WHERE p.id IN ('+marks+')').all(...selectedIds):[];
      return c.json({items:items.map(r=>{const extra=extras.find(e=>e.id===r.id);return {id:r.id,name:r.name,createdAt:r.created_at,updatedAt:r.updated_at,tags:tags.filter(t=>t.target_id===r.id).map(t=>({id:t.id,name:t.name})),...(type==='world'?{cover:extra?.cover??null,defaultPresetId:extra?.default_preset_id??null,defaultApiModelConfigId:extra?.default_api_model_config_id??null,sessionCount:extra?.session_count??0}:{description:extra ? JSON.parse(String(extra.config_json)).description??null : null})};}),hasMore,nextCursor:hasMore&&last?Buffer.from(JSON.stringify({signature,time:last[column],id:last.id})).toString('base64url'):null});
    } catch(error) {return failure(c,error,'INVALID_QUERY');}
  });
}
