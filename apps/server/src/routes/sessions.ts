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
import { worldFailure } from './world-failure.js';
import { readWorld } from '../repositories/world-repository.js';
import { MacKeychainStore, type CredentialStore } from '../infrastructure/credentials/store.js';

const create = z.object({ worldId: z.string().min(1), openingId: z.string().min(1), userCharacterId: z.string().min(1), title: z.string().optional() }).strict();
export function sessionRoutes(db: DatabaseSync, busy: (id:string) => boolean = () => false, removeSessions: <T>(ids:string[], remove:()=>T) => Promise<T> = async (_ids, remove) => remove(), worldDeleting:(id:string)=>boolean = () => false, onUpdated:(id:string)=>void = () => {}, credentials: CredentialStore = new MacKeychainStore()): Hono {
  const app = new Hono();
  app.get('/:id/runs', c => {
    const id=c.req.param('id');
    const row=db.prepare('SELECT tip_entry_id FROM sessions WHERE id=?').get(id);
    if (!row) return c.json(failure(ErrorCodes.SESSION_NOT_FOUND),404);
    const limit=Number(c.req.query('limit') ?? 20);
    try { return c.json(ok(historyRuns(db,id,String(row.tip_entry_id),limit,c.req.query('cursor')))); }
    catch (error) {
      if (error instanceof Error && error.message === 'INVALID_CURSOR') return c.json(failure(ErrorCodes.INVALID_CURSOR),400);
      return c.json(failure(ErrorCodes.INVALID_PARENT_CHAIN),422);
    }
  });
  app.post('/', async c => {
    try {
      const input = create.parse(await c.req.json());
      if (worldDeleting(input.worldId)) return c.json(failure(ErrorCodes.WORLD_BUSY),409);
      const source = db.prepare('SELECT * FROM worlds WHERE id=?').get(input.worldId);
      if (!source) return c.json(failure(ErrorCodes.WORLD_NOT_FOUND),404);
      const presetId=source.default_preset_id as string|null;
      const modelId=source.default_api_model_config_id as string|null;
      if (!presetId || !modelId) return c.json(failure(ErrorCodes.WORLD_CONFIG_INCOMPLETE, '缺少预设或模型配置', { missing: [...(!presetId ? ['presetId'] : []), ...(!modelId ? ['apiModelConfigId'] : [])] }),422);
      if (!db.prepare('SELECT 1 FROM presets WHERE id=?').get(presetId))
        return c.json(failure(ErrorCodes.PRESET_NOT_FOUND),422);
      const modelConfig=db.prepare('SELECT credential_ref FROM api_model_configs WHERE id=?').get(modelId);
      if (!modelConfig) return c.json(failure(ErrorCodes.API_MODEL_CONFIG_NOT_FOUND),422);
      if (!await credentials.get(String(modelConfig.credential_ref)))
        return c.json(failure(ErrorCodes.CREDENTIAL_NOT_CONFIGURED),422);
      return transaction(db,()=>{
        const row = db.prepare('SELECT * FROM worlds WHERE id=?').get(input.worldId);
        if (!row) return c.json(failure(ErrorCodes.WORLD_NOT_FOUND),404);
        if (row.default_preset_id !== presetId || row.default_api_model_config_id !== modelId)
          return c.json(failure(ErrorCodes.TIP_CONFLICT, '世界默认配置已更改'),409);
        let world;
        try {world=readWorld(row).data;} catch(error) {return c.json(worldFailure(error),422);}
        const character = world.characters.find((v: { id: string }) => v.id === input.userCharacterId);
        const opening = world.openings.find((v: { id: string }) => v.id === input.openingId);
        if (!character?.player_selectable || !opening) return c.json(failure(ErrorCodes.INVALID_OPENING_OR_CHARACTER, '开局或玩家身份不存在或不可选'),422);
        const sessionState = initialState(world.state, 'session');
        const messageState = applyOpening(world.state, initialState(world.state, 'message'), opening.initial_state);
        const id = randomUUID(), entryId = randomUUID(), runId = randomUUID(), now = Date.now();
        const message = { role: 'assistant', content: [{ type: 'text', text: opening.content }], timestamp: now };
        db.prepare('INSERT INTO sessions(id,world_id,preset_id,api_model_config_id,user_character_id,tip_entry_id,title,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(id,input.worldId,presetId,modelId,input.userCharacterId,entryId,input.title??null,JSON.stringify(sessionState),now,now);
        db.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,branch_count,timestamp,payload,state,ext_data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(entryId, id, null, runId, 1, 'message', 'assistant', 0, now, JSON.stringify({ message }), JSON.stringify(Object.entries(messageState).map(([key, value]) => ({ key, value }))), JSON.stringify({ run: { status: 'completed' }, origin: 'opening' }));
        return c.json({item:{id,worldId:input.worldId,presetId,apiModelConfigId:modelId,userCharacterId:input.userCharacterId,tipEntryId:entryId,title:input.title??null}},201);
      });
    } catch { return c.json(failure(ErrorCodes.INVALID_SESSION),422); }
  });
  app.patch('/:id', async c => {
    if (busy(c.req.param('id'))) return c.json(failure(ErrorCodes.SESSION_BUSY),409);
    try {
      const patch = z.object({
        title:z.string().nullable().optional(),
        presetId:z.string().min(1).optional(),
        apiModelConfigId:z.string().min(1).optional(),
        userCharacterId:z.string().min(1).optional(),
      }).strict().parse(await c.req.json());
      const row=db.prepare('SELECT * FROM sessions WHERE id=?').get(c.req.param('id'));
      if (!row) return c.json(failure(ErrorCodes.SESSION_NOT_FOUND),404);
      const presetId=patch.presetId ?? String(row.preset_id);
      const modelId=patch.apiModelConfigId ?? String(row.api_model_config_id);
      if (!db.prepare('SELECT 1 FROM presets WHERE id=?').get(presetId))
        return c.json(failure(ErrorCodes.PRESET_NOT_FOUND),422);
      const config=db.prepare('SELECT credential_ref FROM api_model_configs WHERE id=?').get(modelId);
      if (!config) return c.json(failure(ErrorCodes.API_MODEL_CONFIG_NOT_FOUND),422);
      if (!await credentials.get(String(config.credential_ref)))
        return c.json(failure(ErrorCodes.CREDENTIAL_NOT_CONFIGURED),422);
      if (patch.userCharacterId) {
        const world=db.prepare('SELECT * FROM worlds WHERE id=?').get(String(row.world_id));
        if (!world || !readWorld(world).data.characters.some(v => v.id === patch.userCharacterId && v.player_selectable))
          return c.json(failure(ErrorCodes.INVALID_PLAYER_CHARACTER),422);
      }
      // Atomic update, never partially apply a model/preset pair.
      db.prepare('UPDATE sessions SET title=?,preset_id=?,api_model_config_id=?,user_character_id=?,updated_at=? WHERE id=?')
        .run(patch.title!==undefined?patch.title:row.title as string|null,presetId,modelId,patch.userCharacterId??String(row.user_character_id),Date.now(),String(row.id));
      onUpdated(String(row.id));
      return c.json({ok:true});
    } catch { return c.json(failure(ErrorCodes.INVALID_SESSION),422); }
  });
  app.get('/:id/history', c => {
    const id = c.req.param('id');
    const session = db.prepare('SELECT tip_entry_id FROM sessions WHERE id=?').get(id);
    if (!session) return c.json(failure(ErrorCodes.SESSION_NOT_FOUND),404);
    const rawLimit = c.req.query('limit'); const limit = rawLimit === undefined ? 10 : Number(rawLimit);
    const cursor = c.req.query('cursor');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return c.json(failure(ErrorCodes.INVALID_CURSOR, '分页大小无效'),400);
    let before = Number.MAX_SAFE_INTEGER;
    if (cursor) {
      try { const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); if (parsed.sessionId !== id || !Number.isSafeInteger(parsed.before) || parsed.before < 1) throw new Error(); before = parsed.before; }
      catch { return c.json(failure(ErrorCodes.INVALID_CURSOR, '游标无效'),400); }
    }
    let rows:Record<string,any>[];
    try { rows=readAncestors(db,id,String(session.tip_entry_id)); } catch { return c.json(failure(ErrorCodes.INVALID_PARENT_CHAIN),500); }
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
    if (!session) return c.json(failure(ErrorCodes.SESSION_NOT_FOUND),404);
    const world = db.prepare('SELECT * FROM worlds WHERE id=?').get(String(session.world_id));
    if (!world) return c.json(failure(ErrorCodes.WORLD_NOT_FOUND),404);
    let chain:Record<string,any>[];
    try { chain=readAncestors(db,String(session.id),String(session.tip_entry_id)); } catch { return c.json(failure(ErrorCodes.INVALID_PARENT_CHAIN),500); }
    const messageEntry=[...chain].reverse().find(entry=>entry.state !== null);
    let views:{global:Record<string,unknown>;session:Record<string,unknown>;message:Record<string,unknown>};
    try {
      views={global:JSON.parse(String(world.state)),session:JSON.parse(String(session.state)),message:decodeMessageState(String(messageEntry?.state ?? '[]'))};
      const stateDefinition=readWorld(world).data.state;
      for (const scope of ['global','session','message'] as const) validateSnapshot(stateDefinition,scope,views[scope]);
    } catch(error) { return c.json(worldFailure(error),422); }
    return c.json({...views,tipEntryId:session.tip_entry_id});
  });
  app.delete('/:id', async c => {
    const id = c.req.param('id');
    if (!db.prepare('SELECT id FROM sessions WHERE id=?').get(id)) return c.json(failure(ErrorCodes.SESSION_NOT_FOUND),404);
    try {
      await removeSessions([id],()=>{
        db.exec('BEGIN IMMEDIATE');
        try { db.prepare('DELETE FROM entries WHERE session_id=?').run(id); db.prepare('DELETE FROM sessions WHERE id=?').run(id); db.exec('COMMIT'); }
        catch (err) { db.exec('ROLLBACK'); throw err; }
      });
      return c.json({ok:true});
    } catch { return c.json(failure(ErrorCodes.SESSION_DELETE_FAILED),500); }
  });
  app.get('/:id', c => {
    const row = db.prepare('SELECT id,world_id,preset_id,api_model_config_id,user_character_id,tip_entry_id,title,created_at,updated_at FROM sessions WHERE id=?').get(c.req.param('id'));
    if (!row) return c.json(failure(ErrorCodes.SESSION_NOT_FOUND),404);
    return c.json({id:row.id,worldId:row.world_id,presetId:row.preset_id,apiModelConfigId:row.api_model_config_id,userCharacterId:row.user_character_id,tipEntryId:row.tip_entry_id,title:row.title,createdAt:row.created_at,updatedAt:row.updated_at});
  });
  app.get('/', c => {
    try {
      const rows=db.prepare('SELECT s.id,s.world_id,s.preset_id,s.api_model_config_id,s.title,s.updated_at,w.name AS world_name,w.cover AS world_cover FROM sessions s LEFT JOIN worlds w ON w.id=s.world_id ORDER BY s.updated_at DESC,s.id DESC').all();
      const page=pageByUpdated(rows,'sessions',c.req.query('limit'),c.req.query('cursor'));
      return c.json({...page,items:page.items.map(r=>({id:r.id,worldId:r.world_id,presetId:r.preset_id,apiModelConfigId:r.api_model_config_id,title:r.title,updatedAt:r.updated_at,worldName:r.world_name,cover:r.world_cover??null}))});
    } catch { return c.json(failure(ErrorCodes.INVALID_CURSOR, '游标无效'),400); }
  });
  return app;
}
