import { z } from 'zod';
import { parsePromptTemplate } from '../../lib/prompt-template.js';

export const systemNodeIds = ['main', 'personaInfo', 'characterInfo', 'worldInfo', 'chatHistory', 'userInput'] as const;
export const postprocessNodeIds = ['worldState', 'actionSuggestions'] as const;
const builtinIds: readonly string[] = [...systemNodeIds, ...postprocessNodeIds];
export const systemVariableNames = [
  'user', 'persona.prompt', 'characters.prompts', 'world.lore',
  'history.summary', 'history.messages', 'input.text', 'state.message', 'state.session', 'state.global',
] as const;

export const presetNodeSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  kind: z.enum(['system', 'postprocess', 'text']),
  role: z.enum(['system', 'user', 'assistant', 'auto']),
  enabled: z.boolean(),
  // Migrate real placeholders on read/import, preserving backslash escapes and literal braces.
  prompt: z.string().transform(prompt => prompt.replace(
    /\\\\|\\\{\{|\{\{\s*state\.entries\s*\}\}/g,
    token => token.startsWith('{{') ? '{{state.message}}' : token,
  )),
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
    topP: z.number().min(0).max(1).optional(),
    frequencyPenalty: z.number().min(-2).max(2).optional(),
    presencePenalty: z.number().min(-2).max(2).optional(),
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
    try {
      variables = parsePromptTemplate(node.prompt, systemVariableNames)
        .flatMap(segment => segment.type === 'variable' ? [segment.name] : []);
    }
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
