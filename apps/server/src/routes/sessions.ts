import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { z } from 'zod';
import { pageByUpdated } from '../common/pagination.js';
import { readAncestors } from '../domain/session/ancestors.js';
import { historyRuns } from '../domain/session/history-runs.js';
import { ok, failure } from '../common/http-response.js';
import { ErrorCodes } from '../common/error-codes.js';
import { initialState, applyOpening, validateSnapshot, decodeMessageState } from '../domain/state/state.js';

import { transaction } from '../domain/tags.js';
import { readWorld,storedError } from '../domain/world-card.js';

const create = z.object({ worldId: z.string().min(1), openingId: z.string().min(1), userCharacterId: z.string().min(1), title: z.string().optional() }).strict();
export function sessionRoutes(db: DatabaseSync, busy: (id:string) => boolean = () => false, removeSessions: <T>(ids:string[], remove:()=>T) => Promise<T> = async (_ids, remove) => remove(), worldDeleting:(id:string)=>boolean = () => false, onUpdated:(id:string)=>void = () => {}): Hono {
  const app = new Hono();
  app.get('/:id/runs', c => {
    const id=c.req.param('id');
    const row=db.prepare('SELECT tip_entry_id FROM sessions WHERE id=?').get(id);
    if (!row) return c.json(failure(ErrorCodes.SESSION_NOT_FOUND,'会话不存在'),404);
    const limit=Number(c.req.query('limit') ?? 20);
    try { return c.json(ok(historyRuns(db,id,String(row.tip_entry_id),limit,c.req.query('cursor')))); }
    catch (error) {
      if (error instanceof Error && error.message === 'INVALID_CURSOR') return c.json(failure(ErrorCodes.INVALID_CURSOR,'历史游标或页大小无效'),400);
      return c.json(failure(ErrorCodes.INVALID_PARENT_CHAIN,'会话历史链无效'),422);
    }
  });
  app.post('/', async c => {
    try {
      const input = create.parse(await c.req.json());
      if (worldDeleting(input.worldId)) return c.json({error:{code:ErrorCodes.WORLD_BUSY,message:'World is being deleted'}},409);
      return transaction(db,()=>{
        const row = db.prepare('SELECT * FROM worlds WHERE id=?').get(input.worldId);
        if (!row) return c.json({ error: { code: ErrorCodes.WORLD_NOT_FOUND, message: 'World not found' } }, 404);
        let world;
        try {world=readWorld(row).data;} catch(error) {return c.json({error:storedError(error)},422);}
        const presetId=row.preset_id as string|null;
        if(presetId!==null && !db.prepare('SELECT 1 FROM presets WHERE id=?').get(presetId)) return c.json({error:{code:ErrorCodes.PRESET_NOT_FOUND}},422);
        const character = world.characters.find((v: { id: string }) => v.id === input.userCharacterId);
        const opening = world.openings.find((v: { id: string }) => v.id === input.openingId);
        if (!character?.player_selectable || !opening) return c.json({ error: { code: ErrorCodes.INVALID_OPENING_OR_CHARACTER, message: 'Invalid opening or player character' } }, 422);
        const sessionState = initialState(world.state, 'session');
        const messageState = applyOpening(world.state, initialState(world.state, 'message'), opening.initial_state);
        const id = randomUUID(), entryId = randomUUID(), runId = randomUUID(), now = Date.now();
        const message = { role: 'assistant', content: [{ type: 'text', text: opening.content }], timestamp: now };
        db.prepare('INSERT INTO sessions(id,world_id,preset_id,user_character_id,tip_entry_id,title,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, input.worldId, presetId, input.userCharacterId, entryId, input.title ?? null, JSON.stringify(sessionState), now, now);
        db.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,branch_count,timestamp,payload,state,ext_data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(entryId, id, null, runId, 1, 'message', 'assistant', 0, now, JSON.stringify({ message }), JSON.stringify(Object.entries(messageState).map(([key, value]) => ({ key, value }))), JSON.stringify({ run: { status: 'completed' }, origin: 'opening' }));
        return c.json({ item: { id, worldId: input.worldId, presetId, userCharacterId: input.userCharacterId, tipEntryId: entryId, title: input.title ?? null } }, 201);
      });
    } catch (err) { return c.json({ error: { code: ErrorCodes.INVALID_SESSION, message: err instanceof Error ? err.message : 'Invalid session' } }, 422); }
  });
  app.patch('/:id', async c => {
    if (busy(c.req.param('id'))) return c.json({error:{code:ErrorCodes.SESSION_BUSY,message:'Session is running'}},409);
    try {
      const patch = z.object({ title: z.string().nullable().optional(), presetId: z.string().min(1).nullable().optional(), userCharacterId: z.string().min(1).optional() }).strict().parse(await c.req.json());
      const row = db.prepare('SELECT * FROM sessions WHERE id=?').get(c.req.param('id'));
      if (!row) return c.json({ error: { code: ErrorCodes.SESSION_NOT_FOUND, message: 'Session not found' } }, 404);
      if(patch.presetId && !db.prepare('SELECT 1 FROM presets WHERE id=?').get(patch.presetId)) return c.json({error:{code:ErrorCodes.PRESET_NOT_FOUND}},422);
      if (patch.userCharacterId) {
        const world = db.prepare('SELECT * FROM worlds WHERE id=?').get(String(row.world_id));
        if (!world || !JSON.parse(String(world.data_json)).data.characters.some((v: { id:string; player_selectable?:boolean }) => v.id === patch.userCharacterId && v.player_selectable)) throw new Error('Invalid player character');
      }
      db.prepare('UPDATE sessions SET title=?, preset_id=?, user_character_id=?, updated_at=? WHERE id=?').run(patch.title !== undefined ? patch.title : row.title as string | null, patch.presetId !== undefined ? patch.presetId : row.preset_id as string | null, patch.userCharacterId ?? String(row.user_character_id), Date.now(), String(row.id));
      onUpdated(String(row.id));
      return c.json({ ok: true });
    } catch (err) { return c.json({ error: { code: ErrorCodes.INVALID_SESSION, message: err instanceof Error ? err.message : 'Invalid session' } }, 422); }
  });
  app.get('/:id/history', c => {
    const id = c.req.param('id');
    const session = db.prepare('SELECT tip_entry_id FROM sessions WHERE id=?').get(id);
    if (!session) return c.json({ error: { code: ErrorCodes.SESSION_NOT_FOUND, message: 'Session not found' } }, 404);
    const rawLimit = c.req.query('limit'); const limit = rawLimit === undefined ? 10 : Number(rawLimit);
    const cursor = c.req.query('cursor');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return c.json({ error: { code: ErrorCodes.INVALID_CURSOR, message: 'Invalid limit' } }, 400);
    let before = Number.MAX_SAFE_INTEGER;
    if (cursor) {
      try { const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); if (parsed.sessionId !== id || !Number.isSafeInteger(parsed.before) || parsed.before < 1) throw new Error(); before = parsed.before; }
      catch { return c.json({ error: { code: ErrorCodes.INVALID_CURSOR, message: 'Invalid cursor' } }, 400); }
    }
    let rows:Record<string,any>[];
    try { rows=readAncestors(db,id,String(session.tip_entry_id)); } catch { return c.json({error:{code:ErrorCodes.INVALID_PARENT_CHAIN,message:'Invalid entry chain'}},500); }
    const groups = new Map<string, typeof rows>();
    for (const row of rows) { const key = String(row.run_id); const group = groups.get(key) ?? []; group.push(row); groups.set(key, group); }
    const selected = [...groups.entries()].map(([runId, entries]) => ({ runId, entries, start: Number(entries[0]?.seq) })).filter(g => g.start < before).sort((a,b) => b.start-a.start);
    const runs = selected.slice(0, limit).map(group => ({ runId: group.runId, status: group.entries.map(e => JSON.parse(String(e.ext_data)).run?.status).find(Boolean) ?? 'completed', entries: group.entries.flatMap(entry => {
      if (entry.type !== 'message' || !['user','assistant'].includes(String(entry.role))) return [];
      const ext = JSON.parse(String(entry.ext_data)); if (ext.nonNarrative) return [];
      const message = JSON.parse(String(entry.payload)).message;
      if (!message || message.role !== entry.role) throw new Error(ErrorCodes.ENTRY_ROLE_MISMATCH);
      const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.filter((part: {type:string}) => part.type === 'text').map((part: {text:string}) => part.text).join('') : '';
      return text ? [{ id: entry.id, role: entry.role, text, branchCount: entry.branch_count }] : [];
    }) }));
    const last = selected[Math.min(limit, selected.length)-1];
    return c.json({ runs, hasMore: selected.length > limit, nextCursor: selected.length > limit && last ? Buffer.from(JSON.stringify({ sessionId: id, before: last.start })).toString('base64url') : null });
  });
  app.get('/:id/state', c => {
    const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(c.req.param('id'));
    if (!session) return c.json({ error: { code: ErrorCodes.SESSION_NOT_FOUND, message: 'Session not found' } }, 404);
    const world = db.prepare('SELECT state,data_json FROM worlds WHERE id=?').get(String(session.world_id));
    if (!world) return c.json({ error: { code: ErrorCodes.WORLD_NOT_FOUND, message: 'World not found' } }, 404);
    let chain:Record<string,any>[];
    try { chain=readAncestors(db,String(session.id),String(session.tip_entry_id)); } catch { return c.json({error:{code:ErrorCodes.INVALID_PARENT_CHAIN,message:'Invalid entry chain'}},500); }
    const messageEntry=[...chain].reverse().find(entry=>entry.state !== null);
    let views:{global:Record<string,unknown>;session:Record<string,unknown>;message:Record<string,unknown>};
    try {
      views={global:JSON.parse(String(world.state)),session:JSON.parse(String(session.state)),message:decodeMessageState(String(messageEntry?.state ?? '[]'))};
      const stateDefinition=readWorld(world).data.state;
      for (const scope of ['global','session','message'] as const) validateSnapshot(stateDefinition,scope,views[scope]);
    } catch(error) { return c.json({error:storedError(error)},422); }
    return c.json({...views,tipEntryId:session.tip_entry_id});
  });
  app.delete('/:id', async c => {
    const id = c.req.param('id');
    if (!db.prepare('SELECT id FROM sessions WHERE id=?').get(id)) return c.json({ error: { code: ErrorCodes.SESSION_NOT_FOUND, message: 'Session not found' } }, 404);
    try {
      await removeSessions([id],()=>{
        db.exec('BEGIN IMMEDIATE');
        try { db.prepare('DELETE FROM entries WHERE session_id=?').run(id); db.prepare('DELETE FROM sessions WHERE id=?').run(id); db.exec('COMMIT'); }
        catch (err) { db.exec('ROLLBACK'); throw err; }
      });
      return c.json({ok:true});
    } catch { return c.json({ error: { code: ErrorCodes.SESSION_DELETE_FAILED, message: 'Could not delete session' } }, 500); }
  });
  app.get('/:id', c => {
    const row = db.prepare('SELECT id,world_id,preset_id,user_character_id,tip_entry_id,title,created_at,updated_at FROM sessions WHERE id=?').get(c.req.param('id'));
    if (!row) return c.json({ error: { code: ErrorCodes.SESSION_NOT_FOUND, message: 'Session not found' } }, 404);
    return c.json({id:row.id,worldId:row.world_id,presetId:row.preset_id,userCharacterId:row.user_character_id,tipEntryId:row.tip_entry_id,title:row.title,createdAt:row.created_at,updatedAt:row.updated_at});
  });
  app.get('/', c => {
    try {
      const rows=db.prepare('SELECT s.id,s.world_id,s.preset_id,s.title,s.updated_at,w.name AS world_name,w.data_json AS world_data FROM sessions s LEFT JOIN worlds w ON w.id=s.world_id ORDER BY s.updated_at DESC,s.id DESC').all();
      const page=pageByUpdated(rows,'sessions',c.req.query('limit'),c.req.query('cursor'));
      return c.json({...page,items:page.items.map(r=>({id:r.id,worldId:r.world_id,presetId:r.preset_id,title:r.title,updatedAt:r.updated_at,worldName:r.world_name,cover:r.world_data?JSON.parse(String(r.world_data)).data.cover:null}))});
    } catch { return c.json({error:{code:ErrorCodes.INVALID_CURSOR,message:'Invalid cursor or limit'}},400); }
  });
  return app;
}
