import { ErrorCodes } from '../common/error-codes.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { transaction, targetRoutes, importTags, tagNames, clearTags } from '../domain/tags.js';
import { z } from 'zod';

const ids = ['main', 'personaInfo', 'characterInfo', 'worldState', 'chatHistory', 'userInput', 'postHistory'];
const node = z.object({ id: z.string().min(1), kind: z.enum(['system', 'text']), name: z.string(), source: z.string().optional(), role: z.enum(['system', 'user', 'assistant', 'auto']), enabled: z.boolean(), content: z.string().optional() }).strict();
const preset = z.object({ name: z.string().trim().min(1), description: z.string().optional(), api_model_config_id: z.string().min(1).nullable().default(null), model_parameters: z.object({temperature:z.number().min(0).max(2).optional()}).strict().optional(), budget: z.object({ max_context_tokens: z.number().int().positive().optional(), max_output_tokens: z.number().int().positive() }), summary_prompt: z.string(), nodes: z.array(node) }).strict().superRefine((p, ctx) => {
  if ('state_update_mode' in p) ctx.addIssue({code:'custom',message:'state_update_mode is unsupported; state updates use tools only'});
  const nodeIds = p.nodes.map(n => n.id);
  if (new Set(nodeIds).size !== nodeIds.length) ctx.addIssue({ code: 'custom', message: 'Duplicate node ID' });
  for (const id of ids) {
    const n = p.nodes.find(n => n.id === id);
    if (!n || n.kind !== 'system' || n.source !== id) ctx.addIssue({ code: 'custom', message: `Invalid system node ${id}` });
  }
  for (const n of p.nodes) if (n.id !== 'postHistory' && !n.enabled) ctx.addIssue({ code:'custom', message:`Node ${n.id} must be enabled` });
  for (const n of p.nodes) if ((n.id === 'chatHistory' && n.role !== 'auto') || (n.id === 'userInput' && n.role !== 'user') || (n.id !== 'chatHistory' && n.role === 'auto') || (n.kind === 'text' && n.source !== undefined)) ctx.addIssue({ code: 'custom', message: `Invalid role or source for ${n.id}` });
});
const normalizeStored = (value: any) => ({...value,nodes:value.nodes.map((n: {id:string})=>n.id==='postHistory'?n:{...n,enabled:true})});
const nodePatch = node.partial().extend({ id: z.string().min(1) }).strict();
const patch = z.object({ name: z.string().min(1).optional(), description: z.string().nullable().optional(), api_model_config_id: z.string().min(1).nullable().optional(), model_parameters: z.object({temperature:z.number().min(0).max(2).optional()}).strict().optional(), budget: z.object({ max_context_tokens: z.number().int().positive().nullable().optional(), max_output_tokens: z.number().int().positive().optional() }).optional(), summary_prompt: z.string().optional(), nodes: z.array(nodePatch).optional(), add_nodes: z.array(node).optional(), remove_node_ids: z.array(z.string()).optional(), nodes_order: z.array(z.string()).optional() }).strict();

export function presetRoutes(db: DatabaseSync): Hono {
  const app = new Hono();
  targetRoutes(app,db,'preset');
  const read = (id: string) => db.prepare('SELECT * FROM presets WHERE id=?').get(id);
  const missing={error:{code:ErrorCodes.PRESET_NOT_FOUND,message:'Preset not found'}};
  const create = async (c: import('hono').Context, imported: boolean) => {
    try {
      const input=z.record(z.string(),z.unknown()).parse(await c.req.json());
      const names=z.array(z.string().trim().min(1)).default([]).parse(input.tags);
      delete input.tags;
      if (imported) {
        for(const key of Object.keys(input)) if(!(key in preset.shape)) delete input[key];
        input.api_model_config_id=null;
      }
      const value=preset.parse(input);
      if(value.api_model_config_id && !db.prepare('SELECT 1 FROM api_model_configs WHERE id=?').get(value.api_model_config_id))
        return c.json({error:{code:ErrorCodes.API_MODEL_CONFIG_NOT_FOUND}},422);
      const id=randomUUID(), now=Date.now();
      transaction(db,()=>{
        const base=value.name;
        const used=db.prepare('SELECT 1 FROM presets WHERE name=?');
        for(let i=1;used.get(value.name);i++) value.name=base+'('+i+')';
        db.prepare('INSERT INTO presets(id,name,config_json,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,value.name,JSON.stringify(value),now,now);
        importTags(db,'preset',id,names);
      });
      return c.json({item:{id,...value,tags:tagNames(db,'preset',id)},warnings:[]},201);
    } catch(err) {return c.json({error:{code:ErrorCodes.INVALID_PRESET,message:err instanceof Error?err.message:'Invalid preset'}},422);}
  };
  app.post('/',c=>create(c,false));
  app.post('/import',c=>create(c,true));
  app.get('/:id/export',c=>{
    const id=c.req.param('id'), row=read(id);
    if(!row) return c.json(missing,404);
    const value=preset.parse(normalizeStored(JSON.parse(String(row.config_json))));
    const {name,description,budget,model_parameters,summary_prompt,nodes}=value;
    return c.json({name,description,budget,model_parameters,summary_prompt,nodes,tags:tagNames(db,'preset',id)});
  });
  app.get('/:id',c=>{
    const id=c.req.param('id'), row=read(id);
    return row?c.json({item:{id,...normalizeStored(JSON.parse(String(row.config_json))),tags:tagNames(db,'preset',id)}}):c.json(missing,404);
  });
  app.delete('/:id',c=>{
    const id=c.req.param('id');
    if(!read(id)) return c.json(missing,404);
    transaction(db,()=>{
      const now=Date.now();
      db.prepare('UPDATE worlds SET preset_id=NULL,updated_at=? WHERE preset_id=?').run(now,id);
      db.prepare('UPDATE sessions SET preset_id=NULL,updated_at=? WHERE preset_id=?').run(now,id);
      clearTags(db,'preset',id);
      db.prepare('DELETE FROM presets WHERE id=?').run(id);
    });
    return c.json({ok:true});
  });
  app.patch('/:id', async c => {
    try {
      const changes = patch.parse(await c.req.json());
      const row = read(c.req.param('id'));
      if (!row) return c.json({ error: { code: ErrorCodes.PRESET_NOT_FOUND, message: 'Preset not found' } }, 404);
      if (changes.api_model_config_id && !db.prepare('SELECT id FROM api_model_configs WHERE id=?').get(changes.api_model_config_id)) throw new Error('API model configuration not found');
      const current = normalizeStored(JSON.parse(String(row.config_json)));
      const { nodes, add_nodes, remove_node_ids, nodes_order, budget, ...fields } = changes;
      const next = { ...current, ...fields, budget: { ...current.budget, ...budget }, nodes: [...current.nodes] };
      if (next.description === null) delete next.description;
      if (next.budget.max_context_tokens === null) delete next.budget.max_context_tokens;
      if (nodes) {
        if (new Set(nodes.map(n => n.id)).size !== nodes.length) throw new Error('Duplicate node patch');
        for (const change of nodes) {
          const i = next.nodes.findIndex((n: {id:string}) => n.id === change.id);
          if (i < 0) throw new Error('Unknown node');
          const old = next.nodes[i];
          if (change.kind !== undefined && change.kind !== old.kind || change.source !== undefined && change.source !== old.source) throw new Error('Cannot change node identity');
          next.nodes[i] = { ...old, ...change };
        }
      }
      if (remove_node_ids) {
        if (new Set(remove_node_ids).size !== remove_node_ids.length || remove_node_ids.some(id => ids.includes(id) || !next.nodes.some((n: {id:string}) => n.id === id))) throw new Error('Invalid node removal');
        next.nodes = next.nodes.filter((n: {id:string}) => !remove_node_ids.includes(n.id));
      }
      if (add_nodes) { if (add_nodes.some(n => n.kind !== 'text')) throw new Error('Only custom text nodes may be added'); next.nodes.push(...add_nodes); }
      if (nodes_order) {
        if (nodes_order.length !== next.nodes.length || new Set(nodes_order).size !== next.nodes.length || nodes_order.some(id => !next.nodes.some((n: {id:string}) => n.id === id))) throw new Error('Invalid node order');
        next.nodes = nodes_order.map(id => next.nodes.find((n: {id:string}) => n.id === id));
      }
      const validated = preset.parse(next);
      if(db.prepare('SELECT 1 FROM presets WHERE name=? AND id<>?').get(validated.name,String(row.id))) return c.json({error:{code:ErrorCodes.PRESET_NAME_CONFLICT}},409);
      db.prepare('UPDATE presets SET name=?, config_json=?, updated_at=? WHERE id=?').run(validated.name, JSON.stringify(validated), Date.now(), row.id as string);
      return c.json({ item: { id: row.id, ...validated }, warnings:[] });
    } catch (err) { return c.json({ error: { code: ErrorCodes.INVALID_PRESET, message: err instanceof Error ? err.message : 'Invalid preset' } }, 422); }
  });
  return app;
}
