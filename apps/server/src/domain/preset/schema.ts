import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { budgetSchema } from '../preset-budget.js';
import { parsePromptTemplate } from './template.js';

export const systemIds = ['main', 'personaInfo', 'characterInfo', 'worldInfo', 'chatHistory', 'userInput'] as const;
export const postprocessIds = ['worldState', 'actionSuggestions'] as const;
const builtinIds: readonly string[] = [...systemIds, ...postprocessIds];

export const nodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['system', 'postprocess', 'text']),
  role: z.enum(['system', 'user', 'assistant', 'auto']),
  enabled: z.boolean(),
  prompt: z.string(),
}).strict();

export const configSchema = z.object({
  schemaVersion: z.literal(3),
  nodes: z.array(nodeSchema),
}).strict().superRefine((config, ctx) => {
  const nodes = config.nodes, ids = nodes.map(node => node.id);
  const bad = (message: string, path: (string | number)[] = ['nodes']) =>
    ctx.addIssue({ code: 'custom', message, path });

  if (new Set(ids).size !== ids.length) bad('节点 ID 不能重复');
  for (const id of systemIds) {
    const node = nodes.find(node => node.id === id);
    if (!node || node.kind !== 'system' || !node.enabled) bad('缺少必须启用的系统节点：' + id);
  }
  nodes.forEach((node, index) => {
    const reserved = builtinIds.includes(node.id);
    const expectedKind = (systemIds as readonly string[]).includes(node.id) ? 'system' : 'postprocess';
    const expectedRole = node.id === 'chatHistory' ? 'auto' : node.id === 'userInput' ? 'user' : 'system';
    if (reserved && (node.kind !== expectedKind || node.role !== expectedRole)) {
      bad('系统节点的类型和消息角色不可改变：' + node.id, ['nodes', index]);
    }
    if (!reserved && (node.kind !== 'text' || node.role === 'auto')) {
      bad('自定义节点必须使用 text 类型及 system/user/assistant 消息角色', ['nodes', index]);
    }

    let segments;
    try { segments = parsePromptTemplate(node.prompt); }
    catch (error) {
      bad(error instanceof Error ? error.message : '无法解析提示词模板', ['nodes', index, 'prompt']);
      return;
    }
    const names = segments.flatMap(segment => segment.type === 'variable' ? [segment.name] : []);
    for (const [name, owner] of [['history.messages', 'chatHistory'], ['input.text', 'userInput']] as const) {
      const count = names.filter(value => value === name).length;
      if (node.id === owner ? count !== 1 : count !== 0) {
        bad(name + ' 必须且只能在 ' + owner + ' 节点中出现一次', ['nodes', index, 'prompt']);
      }
    }
  });

  const actual = nodes.filter(node => builtinIds.includes(node.id)).map(node => node.id);
  const expected = [...systemIds, ...postprocessIds.filter(id => ids.includes(id))];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    bad('系统节点必须保持既定相对顺序；自定义节点可以插入任意位置');
  }
});

export const contextStrategySchema = budgetSchema.extend({ summary_prompt: z.string().trim().min(1) }).strict();
export const presetSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().nullable(),
  model_parameters: z.object({
    temperature: z.number().min(0).max(2).optional(),
    thinking_enabled: z.boolean().default(false),
  }).strict(),
  context_strategy: contextStrategySchema,
  config_json: configSchema,
}).strict();

export type PresetNode = z.infer<typeof nodeSchema>;
export type PresetConfig = z.infer<typeof presetSchema>;
export function defaultPreset(): PresetConfig {
  return presetSchema.parse(JSON.parse(readFileSync(new URL('../../../resources/presets/default.json', import.meta.url), 'utf8')));
}
