import { AppError } from '../../errors.js';
import { z } from 'zod';
import { parsePromptTemplate } from '../../lib/prompt-template.js';

export const systemNodeIds = ['main', 'personaInfo', 'characterInfo', 'worldInfo', 'worldState', 'chatHistory', 'userInput'] as const;
export const postprocessNodeIds = ['stateUpdate', 'actionSuggestions', 'characterSprite'] as const;
const builtinIds: readonly string[] = [...systemNodeIds, ...postprocessNodeIds];
export const systemVariableNames = [
  'system.language', 'user', 'persona.prompt', 'characters.prompts', 'world.lore',
  'history.summary', 'history.messages', 'input.text', 'state.message', 'state.session', 'state.global',
  'characterSprite.catalog', 'state.update.message',
] as const;

/** The rule projection belongs exclusively to the state-update instruction. */
export function parsePresetNodePrompt(nodeId: string, prompt: string) {
  const segments = parsePromptTemplate(prompt, systemVariableNames);
  if (nodeId !== 'stateUpdate' && segments.some(part => part.type === 'variable' && part.name === 'state.update.message')) {
    throw new AppError('INVALID_NARRATIVE_TEMPLATE', 'state.update.message 只能用于状态更新节点');
  }
  return segments;
}

export const presetNodeSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  kind: z.enum(['system', 'postprocess', 'text']),
  role: z.enum(['system', 'user', 'assistant', 'auto']),
  enabled: z.boolean(),
  prompt: z.string(),
}).strict();

const configShape = z.object({
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
}).strict();

export const narrativeConfigSchema = configShape.superRefine(({ nodes, contextStrategy }, context) => {
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

    if (node.kind === 'postprocess' && node.enabled && !node.prompt.trim())
      invalid('启用的能力节点提示词不能为空', ['nodes', index, 'prompt']);

    let variables: string[];
    try {
      variables = parsePresetNodePrompt(node.id, node.prompt)
        .flatMap(segment => segment.type === 'variable' ? [segment.name] : []);
    }
    catch (error) {
      invalid(error instanceof Error ? error.message : '提示词模板无效', ['nodes', index, 'prompt']);
      continue;
    }
    if (node.kind === 'postprocess' && variables.some(name =>
      name === 'input.text' || name === 'history.messages' || name === 'history.summary'))
      invalid('能力节点不能引用当前输入或历史消息/摘要', ['nodes', index, 'prompt']);
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

const replyNodeIds = ['main', 'sessionGoal', 'personaInfo', 'characterInfo', 'worldInfo', 'currentState', 'chatHistory'];
export const replyVariableNames = ['system.language', 'user', 'persona.prompt', 'characters.prompts', 'world.lore',
  'history.summary', 'history.messages', 'state.message', 'state.session', 'state.global', 'session.reply.assist.goal'] as const;

const replyConfigSchema = configShape.extend({
  contextStrategy: configShape.shape.contextStrategy.extend({ strategy: z.literal('sliding_window'), summaryPrompt: z.literal('').default('') }),
}).superRefine(({ nodes }, context) => {
  const invalid = (message: string) => context.addIssue({ code: 'custom', message, path: ['nodes'] });
  if (new Set(nodes.map(node => node.id)).size !== nodes.length) invalid('节点 ID 不能重复');
  if (nodes.filter(node => node.kind === 'system').map(node => node.id).join(',') !== replyNodeIds.join(',')) invalid('帮答系统节点顺序无效');
  for (const node of nodes) {
    if (replyNodeIds.includes(node.id)) {
      if (node.kind !== 'system' || node.role !== (node.id === 'chatHistory' ? 'auto' : 'system')) invalid('帮答系统节点角色无效');
    } else if (builtinIds.includes(node.id) || node.kind !== 'text' || node.role === 'auto') invalid('帮答自定义节点无效');
    if (node.id === 'main' && (!node.enabled || !node.prompt.trim())) invalid('帮答主提示词必须启用且非空');
    try {
      const segments = parsePromptTemplate(node.prompt, replyVariableNames);
      for (const name of ['history.summary', 'history.messages']) {
        if (segments.filter(part => part.type === 'variable' && part.name === name).length !== (node.id === 'chatHistory' ? 1 : 0))
          invalid(name + ' 必须且只能在聊天历史节点中出现一次');
      }
    } catch (error) { invalid(error instanceof Error ? error.message : '提示词模板无效'); }
  }
});

const sharedValue = z.object({ name: z.string().trim().min(1), description: z.string().nullable().default(null) });
export const presetValueSchema = z.discriminatedUnion('type', [
  sharedValue.extend({ type: z.literal('narrative'), config: narrativeConfigSchema }).strict(),
  sharedValue.extend({ type: z.literal('reply_assist'), config: replyConfigSchema,
    apiModelConfigId: z.string().trim().min(1).nullable().default(null) }).strict(),
]);

export type NarrativePresetConfig = z.infer<typeof narrativeConfigSchema>;
export type PresetNode = z.infer<typeof presetNodeSchema>;
