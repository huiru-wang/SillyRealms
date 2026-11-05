import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { z } from 'zod';

const ids = ['main', 'personaInfo', 'characterInfo', 'worldState', 'chatHistory', 'userInput', 'postHistory'];
const node = z.object({ id: z.string().min(1), kind: z.enum(['system', 'text']), name: z.string(), source: z.string().optional(), role: z.enum(['system', 'user', 'assistant', 'auto']), enabled: z.boolean(), content: z.string().optional() }).strict();
const preset = z.object({ name: z.string().trim().min(1), description: z.string().optional(), api_model_config_id: z.string().min(1).nullable(), model_parameters: z.object({temperature:z.number().min(0).max(2).optional()}).strict().optional(), budget: z.object({ max_context_tokens: z.number().int().positive().optional(), max_output_tokens: z.number().int().positive() }), summary_prompt: z.string(), nodes: z.array(node) }).passthrough().superRefine((p, ctx) => {
  if ('state_update_mode' in p) ctx.addIssue({code:'custom',message:'state_update_mode is unsupported; state updates use tools only'});
  const nodeIds = p.nodes.map(n => n.id);
  if (new Set(nodeIds).size !== nodeIds.length) ctx.addIssue({ code: 'custom', message: 'Duplicate node ID' });
  for (const id of ids) {
    const n = p.nodes.find(n => n.id === id);
    if (!n || n.kind !== 'system' || n.source !== id) ctx.addIssue({ code: 'custom', message: `Invalid system node ${id}` });
  }
  if (!p.nodes.find(n => n.id === 'chatHistory')?.enabled || !p.nodes.find(n => n.id === 'userInput')?.enabled || nodeIds.indexOf('chatHistory') >= nodeIds.indexOf('userInput')) ctx.addIssue({ code: 'custom', message: 'Required nodes must be enabled and ordered' });
  for (const n of p.nodes) if ((n.id === 'chatHistory' && n.role !== 'auto') || (n.id === 'userInput' && n.role !== 'user') || (n.id !== 'chatHistory' && n.role === 'auto') || (n.kind === 'text' && n.source !== undefined)) ctx.addIssue({ code: 'custom', message: `Invalid role or source for ${n.id}` });
});
const nodePatch = node.partial().extend({ id: z.string().min(1) }).strict();
const patch = z.object({ name: z.string().min(1).optional(), description: z.string().nullable().optional(), api_model_config_id: z.string().min(1).nullable().optional(), model_parameters: z.object({temperature:z.number().min(0).max(2).optional()}).strict().optional(), budget: z.object({ max_context_tokens: z.number().int().positive().nullable().optional(), max_output_tokens: z.number().int().positive().optional() }).optional(), summary_prompt: z.string().optional(), nodes: z.array(nodePatch).optional(), add_nodes: z.array(node).optional(), remove_node_ids: z.array(z.string()).optional(), nodes_order: z.array(z.string()).optional() }).strict();

function literalWarnings(value:{summary_prompt:string;nodes:Array<{content?:string}>}) {
  const warnings:Array<{code:string;path:string}>=[];
  if (/<%|\{\{user\}\}/.test(value.summary_prompt)) warnings.push({code:'UNSUPPORTED_TEMPLATE_LITERAL',path:'$.summary_prompt'});
  value.nodes.forEach((node,index)=>{if (node.content && /<%|\{\{user\}\}/.test(node.content)) warnings.push({code:'UNSUPPORTED_TEMPLATE_LITERAL',path:`$.nodes[${index}].content`});});
  return warnings;
}

export function presetRoutes(db: DatabaseSync): Hono {
  const app = new Hono();
  const read = (id: string) => db.prepare('SELECT * FROM presets WHERE id=?').get(id);
  app.get('/', c => c.json({ items: db.prepare('SELECT id,name,is_builtin,created_at,updated_at FROM presets ORDER BY name,id').all() }));
  const create = async (c: any, imported: boolean) => {
    try {
      const value = preset.parse(await c.req.json());
      const configId = value.api_model_config_id;
      const exists = configId === null || !!db.prepare('SELECT id FROM api_model_configs WHERE id=?').get(configId);
      if (!exists && !imported) return c.json({ error: { code: 'API_MODEL_CONFIG_NOT_FOUND', message: 'Model configuration not found' } }, 422);
      const id = randomUUID(), now = Date.now();
      db.prepare('INSERT INTO presets(id,name,config_json,is_builtin,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, value.name, JSON.stringify(value), 0, now, now);
      return c.json({ item: { id, ...value }, warnings: [...literalWarnings(value),...(exists ? [] : [{ code: 'API_MODEL_CONFIG_NOT_FOUND', path: '$.api_model_config_id' }])] }, 201);
    } catch (err) { return c.json({ error: { code: 'INVALID_PRESET', message: err instanceof Error ? err.message : 'Invalid preset' } }, 422); }
  };
  app.post('/', c => create(c, false));
  app.post('/import', c => create(c, true));
  app.get('/:id/export', c => { const row = read(c.req.param('id')); return row ? c.json(JSON.parse(String(row.config_json))) : c.json({ error: { code: 'PRESET_NOT_FOUND', message: 'Preset not found' } }, 404); });
  app.get('/:id', c => { const row = read(c.req.param('id')); return row ? c.json({ item: { id: row.id, ...JSON.parse(String(row.config_json)), isBuiltin: !!row.is_builtin } }) : c.json({ error: { code: 'PRESET_NOT_FOUND', message: 'Preset not found' } }, 404); });
  app.delete('/:id', c => { const result = db.prepare('DELETE FROM presets WHERE id=?').run(c.req.param('id')); return result.changes ? c.json({ ok: true }) : c.json({ error: { code: 'PRESET_NOT_FOUND', message: 'Preset not found' } }, 404); });
  app.patch('/:id', async c => {
    const row = read(c.req.param('id'));
    if (!row) return c.json({ error: { code: 'PRESET_NOT_FOUND', message: 'Preset not found' } }, 404);
    try {
      const changes = patch.parse(await c.req.json());
      if (changes.api_model_config_id && !db.prepare('SELECT id FROM api_model_configs WHERE id=?').get(changes.api_model_config_id)) throw new Error('API model configuration not found');
      const current = JSON.parse(String(row.config_json));
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
      db.prepare('UPDATE presets SET name=?, config_json=?, updated_at=? WHERE id=?').run(validated.name, JSON.stringify(validated), Date.now(), row.id as string);
      return c.json({ item: { id: row.id, ...validated }, warnings:literalWarnings(validated) });
    } catch (err) { return c.json({ error: { code: 'INVALID_PRESET', message: err instanceof Error ? err.message : 'Invalid preset' } }, 422); }
  });
  return app;
}
