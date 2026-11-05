import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { z } from 'zod';
import { initialState, applyOpening } from '../domain/state/state.js';
import { validateWhen } from '../domain/state/when.js';
import { pageByUpdated } from '../common/pagination.js';

const worldSchema = z.object({ spec: z.literal('world_card'), spec_version: z.literal('0.1'), data: z.object({
  name: z.string().trim().min(1), tags: z.array(z.string()).optional(),
  characters: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), player_selectable: z.boolean().optional() }).passthrough()),
  openings: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), content: z.string().min(1), initial_state: z.unknown().optional() }).passthrough()).min(1),
  state: z.unknown().optional(), lorebook: z.object({entries:z.array(z.object({id:z.string().min(1),content:z.string()}).passthrough())}).passthrough().optional(), context: z.unknown().optional(),
}).passthrough() }).passthrough();

function validateRules(value: unknown, depth = 0, path = '$.data'): void {
  if (depth > 64) throw new Error('World exceeds maximum depth');
  if (Array.isArray(value)) { value.forEach((item,index) => validateRules(item, depth + 1, `${path}[${index}]`)); return; }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (record.load && typeof record.load === 'object' && !Array.isArray(record.load)) {
    const rule = record.load as Record<string, unknown>;
    if ('role' in rule || 'depth' in rule || 'injection_role' in rule || 'injection_depth' in rule) throw new Error('Unsupported injection control');
    if (rule.mode !== undefined && rule.mode !== 'always' && rule.mode !== 'on_mention') throw new Error('Invalid load mode');
    if (rule.when !== undefined) { if (typeof rule.when !== 'string') throw new Error(`${path}.load.when: invalid expression`); try { validateWhen(rule.when); } catch { throw new Error(`${path}.load.when: unsupported expression`); } }
    if (rule.mode === 'on_mention' && (!Array.isArray(rule.keywords) || !rule.keywords.length || !rule.keywords.every((k) => typeof k === 'string' && k.length > 0))) throw new Error(`${path}.load.keywords: on_mention requires at least one nonempty keyword`);
  }
  for (const [key,item] of Object.entries(record)) validateRules(item, depth + 1, `${path}.${key}`);
}

export function worldRoutes(db: DatabaseSync, removeWorld: <T>(worldId:string, ids:()=>string[], remove:()=>T) => Promise<T> = async (_worldId, _ids, remove) => remove()): Hono {
  const app = new Hono();
  app.get('/', c => {
    const query = c.req.query('query') ?? '';
    const rows = db.prepare('SELECT id, name, data_json, created_at, updated_at FROM worlds ORDER BY updated_at DESC, id DESC').all();
    const tag = c.req.query('tag');
    try {
      const page=pageByUpdated(rows.filter(row => String(row.name).includes(query) && (!tag || (JSON.parse(String(row.data_json)).data.tags ?? []).includes(tag))),'worlds',c.req.query('limit'),c.req.query('cursor'));
      return c.json({...page,items:page.items.map(row => ({ id:row.id, name:row.name, createdAt:row.created_at, updatedAt:row.updated_at }))});
    } catch { return c.json({error:{code:'INVALID_CURSOR',message:'Invalid cursor or limit'}},400); }
  });
  app.post('/import', async c => {
    try {
      const form = await c.req.formData();
      const file = form.get('file');
      if (!(file instanceof File) || file.size > 10 * 1024 * 1024) throw new Error('Expected JSON file under 10 MiB');
      const world = worldSchema.parse(JSON.parse(await file.text()));
      const data = world.data;
      if (new Set(data.characters.map(x => x.id)).size !== data.characters.length || new Set(data.openings.map(x => x.id)).size !== data.openings.length) throw new Error('Duplicate character or opening id');
      if ('prompts' in data) throw new Error('Unsupported world prompts');
      if (data.lorebook && new Set(data.lorebook.entries.map(v => v.id)).size !== data.lorebook.entries.length) throw new Error('Duplicate lore entry id');
      for (const entry of data.lorebook?.entries ?? []) {
        const load = entry.load as Record<string,unknown> | undefined;
        if (load?.anchor !== undefined && !['personaInfo','characterInfo','worldState','userInput'].includes(String(load.anchor))) throw new Error('Invalid lore anchor');
        if (load?.position !== undefined && !['before','after'].includes(String(load.position))) throw new Error('Invalid lore position');
      }
      validateRules(data.characters,0,'$.data.characters'); validateRules(data.lorebook,0,'$.data.lorebook'); validateRules(data.state,0,'$.data.state');
      const global = initialState(data.state, 'global'); initialState(data.state, 'session');
      const message = initialState(data.state, 'message');
      for (const opening of data.openings) applyOpening(data.state, message, opening.initial_state);
      const tags = [...new Set((data.tags ?? []).map(t => t.trim()))];
      if (tags.some(t => !t)) throw new Error('Empty tag');
      data.tags = tags;
      const now = Date.now(); const id = randomUUID();
      const warnings: Array<{ code: string; path: string }> = [];
      if (Array.isArray(data.assets) && data.assets.length) warnings.push({ code: 'ASSETS_NOT_PACKAGED', path: '$.data.assets' });
      if (Array.isArray(data.regex_scripts) && data.regex_scripts.length) warnings.push({ code: 'REGEX_SCRIPTS_NOT_EXECUTED', path: '$.data.regex_scripts' });
      if (data.context !== undefined) warnings.push({ code: 'CONTEXT_CONFIG_IGNORED', path: '$.data.context' });
      for (const [index, character] of data.characters.entries()) if (typeof character.description === 'string' && /<%|\{\{user\}\}/.test(character.description)) warnings.push({code:'UNSUPPORTED_TEMPLATE_LITERAL',path:`$.data.characters[${index}].description`});
      for (const [index, entry] of (data.lorebook?.entries ?? []).entries()) if (/<%|\{\{user\}\}/.test(entry.content)) warnings.push({code:'UNSUPPORTED_TEMPLATE_LITERAL',path:`$.data.lorebook.entries[${index}].content`});
      for (const [index, opening] of data.openings.entries()) if (/<%|\{\{user\}\}/.test(opening.content)) warnings.push({code:'UNSUPPORTED_TEMPLATE_LITERAL',path:`$.data.openings[${index}].content`});
      db.exec('BEGIN IMMEDIATE');
      try {
        const insertTag = db.prepare('INSERT INTO tags(id,type,name,sort_order,created_at) VALUES(?,?,?,?,?) ON CONFLICT(type,name) DO NOTHING');
        for (const tag of tags) insertTag.run(randomUUID(), 'world', tag, 0, now);
        db.prepare('INSERT INTO worlds(id,name,data_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, data.name, JSON.stringify(world), JSON.stringify(global), now, now);
        db.exec('COMMIT');
      } catch (err) { db.exec('ROLLBACK'); throw err; }
      return c.json({ item: { id, ...world }, warnings }, 201);
    } catch (err) { return c.json({ error: { code: 'INVALID_WORLD', message: err instanceof Error ? err.message : 'Invalid world' } }, 422); }
  });
  app.delete('/:id', async c => {
    const id = c.req.param('id');
    if (!db.prepare('SELECT id FROM worlds WHERE id=?').get(id)) return c.json({ error: { code: 'WORLD_NOT_FOUND', message: 'World not found' } }, 404);
    try {
      await removeWorld(id,()=>db.prepare('SELECT id FROM sessions WHERE world_id=?').all(id).map(row=>String(row.id)),()=>{
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('DELETE FROM entries WHERE session_id IN (SELECT id FROM sessions WHERE world_id=?)').run(id);
          db.prepare('DELETE FROM sessions WHERE world_id=?').run(id);
          db.prepare('DELETE FROM worlds WHERE id=?').run(id);
          db.exec('COMMIT');
        } catch (err) { db.exec('ROLLBACK'); throw err; }
      });
      return c.json({ok:true});
    } catch { return c.json({ error: { code: 'WORLD_DELETE_FAILED', message: 'Could not delete world' } }, 500); }
  });
  app.get('/:id/export', c => {
    const row = db.prepare('SELECT data_json FROM worlds WHERE id = ?').get(c.req.param('id'));
    if (!row) return c.json({ error: { code: 'WORLD_NOT_FOUND', message: 'World not found' } }, 404);
    return c.json(JSON.parse(String(row.data_json)));
  });
  app.get('/:id', c => {
    const row = db.prepare('SELECT id,data_json,created_at,updated_at FROM worlds WHERE id = ?').get(c.req.param('id'));
    if (!row) return c.json({ error: { code: 'WORLD_NOT_FOUND', message: 'World not found' } }, 404);
    return c.json({ item: { id: row.id, ...JSON.parse(String(row.data_json)), createdAt: row.created_at, updatedAt: row.updated_at } });
  });
  return app;
}
