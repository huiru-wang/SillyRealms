import { readRunPage } from '../domain/session/history-page.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { z } from 'zod';
import { pageByUpdated } from '../common/pagination.js';
import { readAncestors } from '../domain/session/ancestors.js';
import { failure } from '../common/http-response.js';
import { effectiveCapabilities, capabilityOverridesSchema } from '../runtime/config.js';
import { publicRunResult } from '../domain/session/run-result.js';
import { ErrorCodes } from '../common/error-codes.js';
import { initialState, applyOpening, validateSnapshot, decodeMessageState } from '../domain/state/state.js';

import { transaction } from '../domain/tags.js';
import { worldFailure } from './world-failure.js';
import { readWorld } from '../repositories/world-repository.js';
import { MacKeychainStore, type CredentialStore } from '../infrastructure/credentials/store.js';

const create = z.object({ worldId: z.string().min(1), openingId: z.string().min(1), userCharacterId: z.string().min(1), title: z.string().optional() }).strict();
export function sessionRoutes(db: DatabaseSync, busy: (id:string) => boolean = () => false, removeSessions: <T>(ids:string[], remove:()=>T) => Promise<T> = async (_ids, remove) => remove(), worldDeleting:(id:string)=>boolean = () => false, onUpdated:(id:string)=>void = () => {}, credentials: CredentialStore = new MacKeychainStore(), activeRun: (id:string)=>Record<string, any>|null = () => null): Hono {
  const app = new Hono();
  const capabilityView = (id: string) => {
    const row = db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
    if (!row) return null;
    const presetRow = db.prepare('SELECT config_json FROM presets WHERE id=?').get(String(row.preset_id));
    const preset = presetRow ? JSON.parse(String(presetRow.config_json)) : {};
    const overrides = capabilityOverridesSchema.parse(JSON.parse(String(row.capability_overrides_json)));
    const effective = effectiveCapabilities(preset.capabilities, overrides);
    const source = (name: 'state_update' | 'action_suggestions') => Object.hasOwn(overrides,name)
      ? 'session' : Object.hasOwn(preset.capabilities?.[name] ?? {},'enabled') ? 'preset' : 'platform';
    return { revision:Number(row.capability_revision), overrides,
      effective: { state_update:{enabled:effective.state_update.enabled},
        action_suggestions:{enabled:effective.action_suggestions.enabled,count:effective.action_suggestions.count} },
      sources:{state_update:source('state_update'),action_suggestions:source('action_suggestions')},
      availability:{applicable:row.execution_mode==='direct',reason:row.execution_mode==='direct'?null:'agent_mode'},
      activeRun:activeRun(id),
    };
  };
  app.get('/:id/capabilities', c => {
    const view=capabilityView(c.req.param('id'));
    return view?c.json(view):c.json(failure(ErrorCodes.SESSION_NOT_FOUND),404);
  });
  app.patch('/:id/capabilities', async c => {
    const parsed=z.object({
      expectedRevision:z.number().int().nonnegative(),
      overrides:z.object({state_update:z.boolean().nullable().optional(),action_suggestions:z.boolean().nullable().optional()}).strict(),
    }).strict().safeParse(await c.req.json().catch(()=>null));
    if(!parsed.success)return c.json(failure(ErrorCodes.INVALID_CAPABILITY_CONFIG),422);
    const id=c.req.param('id');
    return transaction(db,()=>{
      const row=db.prepare('SELECT capability_revision,capability_overrides_json FROM sessions WHERE id=?').get(id);
      if(!row)return c.json(failure(ErrorCodes.SESSION_NOT_FOUND),404);
      if(Number(row.capability_revision)!==parsed.data.expectedRevision)return c.json(failure(ErrorCodes.CAPABILITY_REVISION_CONFLICT),409);
      const overrides=JSON.parse(String(row.capability_overrides_json));
      for(const [key,value] of Object.entries(parsed.data.overrides)) {
        if(value===null)delete overrides[key];else overrides[key]=value;
      }
      db.prepare('UPDATE sessions SET capability_overrides_json=?,capability_revision=capability_revision+1,updated_at=? WHERE id=?')
        .run(JSON.stringify(overrides),Date.now(),id);
      return c.json(capabilityView(id));
    });
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
        db.prepare('INSERT INTO sessions(id,world_id,preset_id,api_model_config_id,user_character_id,tip_entry_id,title,state,created_at,updated_at,execution_mode) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(id,input.worldId,presetId,modelId,input.userCharacterId,entryId,input.title??null,JSON.stringify(sessionState),now,now,'direct');
        db.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,branch_count,timestamp,payload,state,ext_data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(entryId, id, null, runId, 1, 'message', 'assistant', 0, now, JSON.stringify({ message }), JSON.stringify(Object.entries(messageState).map(([key, value]) => ({ key, value }))), JSON.stringify({ run: { status: 'completed' }, origin: 'opening' }));
        return c.json({item:{id,worldId:input.worldId,presetId,apiModelConfigId:modelId,userCharacterId:input.userCharacterId,executionMode:'direct',tipEntryId:entryId,title:input.title??null}},201);
      });
    } catch { return c.json(failure(ErrorCodes.INVALID_SESSION),422); }
  });
  app.patch('/:id', async c => {
    if (busy(c.req.param('id'))) return c.json(failure(ErrorCodes.SESSION_BUSY),409);
    try {
      const patch = z.object({
        title:z.string().nullable().optional(),
        executionMode:z.enum(['direct','agent']).optional(),
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
      if (busy(c.req.param('id'))) return c.json(failure(ErrorCodes.SESSION_BUSY),409);
      // Atomic update, never partially apply a model/preset pair.
      db.prepare('UPDATE sessions SET title=?,preset_id=?,api_model_config_id=?,user_character_id=?,execution_mode=?,updated_at=? WHERE id=?')
        .run(patch.title!==undefined?patch.title:row.title as string|null,presetId,modelId,patch.userCharacterId??String(row.user_character_id),patch.executionMode??String(row.execution_mode),Date.now(),String(row.id));
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
    let page: ReturnType<typeof readRunPage>;
    try { page = readRunPage(db, id, String(session.tip_entry_id), limit, cursor); }
    catch (error) {
      if (error instanceof Error && error.message === ErrorCodes.INVALID_CURSOR) return c.json(failure(ErrorCodes.INVALID_CURSOR),400);
      return c.json(failure(ErrorCodes.INVALID_PARENT_CHAIN),500);
    }
    const selected = [...page.groups].reverse().map(group => ({ runId: group.id, entries: group.rows }));
    const runs = selected.slice(0, limit).map(group => ({ ...publicRunResult(group.entries.map(e=>JSON.parse(String(e.ext_data)).run).find(Boolean)??{}), runId: group.runId, status: publicRunResult(group.entries.map(e => JSON.parse(String(e.ext_data)).run).find(Boolean)??{status:'completed'}).status, entries: group.entries.flatMap(entry => {
      if (entry.type !== 'message' || !['user','assistant'].includes(String(entry.role))) return [];
      const ext = JSON.parse(String(entry.ext_data)); if (ext.nonNarrative) return [];
      const message = JSON.parse(String(entry.payload)).message;
      if (!message || message.role !== entry.role) throw new Error(ErrorCodes.ENTRY_ROLE_MISMATCH);
      const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.filter((part: {type:string}) => part.type === 'text').map((part: {text:string}) => part.text).join('') : '';
      return text ? [{ id: entry.id, role: entry.role, text, branchCount: entry.branch_count }] : [];
    }) }));
    return c.json({ runs, hasMore: page.hasMore, nextCursor: page.nextCursor });
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
    const row = db.prepare('SELECT id,world_id,preset_id,api_model_config_id,user_character_id,execution_mode,tip_entry_id,title,created_at,updated_at FROM sessions WHERE id=?').get(c.req.param('id'));
    if (!row) return c.json(failure(ErrorCodes.SESSION_NOT_FOUND),404);
    return c.json({id:row.id,worldId:row.world_id,presetId:row.preset_id,apiModelConfigId:row.api_model_config_id,userCharacterId:row.user_character_id,executionMode:row.execution_mode,activeRun:activeRun(String(row.id)),tipEntryId:row.tip_entry_id,title:row.title,createdAt:row.created_at,updatedAt:row.updated_at});
  });
  app.get('/', c => {
    const worldId=c.req.query('worldId');
    if (worldId !== undefined && !worldId.trim()) return c.json(failure(ErrorCodes.INVALID_REQUEST, '世界 ID 不能为空'),400);
    try {
      const sql='SELECT s.id,s.world_id,s.preset_id,s.api_model_config_id,s.title,s.updated_at,w.name AS world_name,w.cover AS world_cover FROM sessions s LEFT JOIN worlds w ON w.id=s.world_id'+(worldId === undefined ? '' : ' WHERE s.world_id=?')+' ORDER BY s.updated_at DESC,s.id DESC';
      const rows=worldId === undefined ? db.prepare(sql).all() : db.prepare(sql).all(worldId);
      const page=pageByUpdated(rows,'sessions',c.req.query('limit'),c.req.query('cursor'),worldId);
      return c.json({...page,items:page.items.map(r=>({id:r.id,worldId:r.world_id,presetId:r.preset_id,apiModelConfigId:r.api_model_config_id,title:r.title,updatedAt:r.updated_at,worldName:r.world_name,cover:r.world_cover??null}))});
    } catch { return c.json(failure(ErrorCodes.INVALID_CURSOR, '游标无效'),400); }
  });
  return app;
}
