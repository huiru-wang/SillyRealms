import { z } from 'zod';

export const systemNodeIds = ['main', 'personaInfo', 'characterInfo', 'worldInfo', 'chatHistory', 'userInput'] as const;
export const postprocessNodeIds = ['worldState', 'actionSuggestions'] as const;
const builtinIds: readonly string[] = [...systemNodeIds, ...postprocessNodeIds];
const systemVariables = new Set([
  'user', 'persona.prompt', 'characters.prompts', 'world.lore',
  'history.summary', 'history.messages', 'input.text', 'state.entries',
]);

/** Inspect template syntax only; values will never be evaluated as object paths. */
function templateVariables(prompt: string): string[] {
  const names: string[] = [];
  for (let index = 0; index < prompt.length;) {
    if (prompt[index] === '\\') {
      if (prompt[index + 1] === '\\') { index += 2; continue; }
      if (prompt.startsWith('{{', index + 1)) { index += 3; continue; }
    }
    if (!prompt.startsWith('{{', index)) { index++; continue; }
    const end = prompt.indexOf('}}', index + 2);
    if (end === -1) throw new Error('系统变量缺少结束标记 }}');
    const name = prompt.slice(index + 2, end).trim();
    if (!systemVariables.has(name)) throw new Error('未知系统变量：' + (name || '空名称'));
    names.push(name);
    index = end + 2;
  }
  return names;
}

export const presetNodeSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  kind: z.enum(['system', 'postprocess', 'text']),
  role: z.enum(['system', 'user', 'assistant', 'auto']),
  enabled: z.boolean(),
  prompt: z.string(),
}).strict();

export const narrativeConfigSchema = z.object({
  schemaVersion: z.literal(1),
  nodes: z.array(presetNodeSchema),
  contextStrategy: z.object({
    strategy: z.enum(['rolling_summary', 'sliding_window']),
    maxContextTokens: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER),
    maxOutputTokens: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    summaryPrompt: z.string(),
  }).strict(),
  modelParameters: z.object({
    temperature: z.number().min(0).max(2).optional(),
    thinkingEnabled: z.boolean().default(false),
    thinkingLevel: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
  }).strict(),
}).strict().superRefine(({ nodes, contextStrategy }, context) => {
  if (contextStrategy.strategy === 'rolling_summary' && !contextStrategy.summaryPrompt.trim()) {
    context.addIssue({ code: 'custom', path: ['contextStrategy', 'summaryPrompt'], message: '滚动摘要的提示词不能为空' });
  }
  const ids = nodes.map(node => node.id);
  const invalid = (message: string, path: (string | number)[] = ['nodes']) =>
    context.addIssue({ code: 'custom', message, path });

  if (new Set(ids).size !== ids.length) invalid('节点 ID 不能重复');
  for (const id of systemNodeIds) {
    const node = nodes.find(item => item.id === id);
    if (!node || node.kind !== 'system' || !node.enabled) invalid('缺少必须启用的系统节点：' + id);
  }
  for (const [index, node] of nodes.entries()) {
    const reserved = builtinIds.includes(node.id);
    const expectedKind = (systemNodeIds as readonly string[]).includes(node.id) ? 'system' : 'postprocess';
    const expectedRole = node.id === 'chatHistory' ? 'auto' : node.id === 'userInput' ? 'user' : 'system';
    if (reserved && (node.kind !== expectedKind || node.role !== expectedRole))
      invalid('系统节点的类型和消息角色不可改变：' + node.id, ['nodes', index]);
    if (!reserved && (node.kind !== 'text' || node.role === 'auto'))
      invalid('自定义节点必须使用 text 类型及 system/user/assistant 消息角色', ['nodes', index]);

    let variables: string[];
    try { variables = templateVariables(node.prompt); }
    catch (error) {
      invalid(error instanceof Error ? error.message : '提示词模板无效', ['nodes', index, 'prompt']);
      continue;
    }
    for (const [name, owner] of [['history.messages', 'chatHistory'], ['input.text', 'userInput']] as const) {
      const count = variables.filter(value => value === name).length;
      if (node.id === owner ? count !== 1 : count !== 0)
        invalid(name + ' 必须且只能在 ' + owner + ' 节点中出现一次', ['nodes', index, 'prompt']);
    }
  }

  const actual = nodes.filter(node => builtinIds.includes(node.id)).map(node => node.id);
  const expected = [...systemNodeIds, ...postprocessNodeIds.filter(id => ids.includes(id))];
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    invalid('系统节点必须保持既定相对顺序；自定义节点可以插入任意位置');
});

export const presetValueSchema = z.object({
  type: z.literal('narrative'),
  name: z.string().trim().min(1),
  description: z.string().nullable().default(null),
  config: narrativeConfigSchema,
}).strict();

export type NarrativePresetConfig = z.infer<typeof narrativeConfigSchema>;
export type PresetNode = z.infer<typeof presetNodeSchema>;
