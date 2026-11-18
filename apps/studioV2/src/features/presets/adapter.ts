import type { StudioPreset, PresetDetail, PresetInput } from './types.js';

const systemIds = ['main', 'personaInfo', 'characterInfo', 'worldInfo', 'chatHistory', 'userInput'];
const postprocessIds = ['worldState', 'actionSuggestions'];

export function fromServer(raw: PresetDetail): StudioPreset {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description ?? '',
    contextStrategy: raw.config.contextStrategy.strategy,
    maxContextTokens: raw.config.contextStrategy.maxContextTokens,
    maxOutputTokens: raw.config.contextStrategy.maxOutputTokens,
    temperature: raw.config.modelParameters.temperature,
    thinkingEnabled: raw.config.modelParameters.thinkingEnabled,
    summaryPrompt: raw.config.contextStrategy.summaryPrompt,
    nodes: structuredClone(raw.config.nodes),
    revision: raw.revision,
  };
}

export function getPresetValidationError(preset: StudioPreset): string | null {
  if (preset.contextStrategy === 'rolling_summary' && !preset.summaryPrompt.trim()) return '压缩提示词不能为空。';
  if (!preset.name.trim()) return '请输入预设名称。';
  if (!['rolling_summary', 'sliding_window'].includes(preset.contextStrategy)) return '请选择上下文策略。';
  if (!Number.isSafeInteger(preset.maxContextTokens) || preset.maxContextTokens < 2 || !Number.isSafeInteger(preset.maxOutputTokens) || preset.maxOutputTokens < 1) return '请输入有效的上下文和输出预算。';
  if (preset.temperature !== undefined && (!Number.isFinite(preset.temperature) || preset.temperature < 0 || preset.temperature > 2)) return '温度必须在 0 到 2 之间。';
  if (typeof preset.thinkingEnabled !== 'boolean') return '请选择是否开启深度思考。';
  const ids = new Set<string>();
  for (const node of preset.nodes) {
    if (!node.id || ids.has(node.id) || !node.name.trim() || typeof node.prompt !== 'string' || typeof node.enabled !== 'boolean') return '请检查节点名称、提示词和 ID。';
    ids.add(node.id);
    const required = systemIds.includes(node.id), optional = postprocessIds.includes(node.id);
    if (required || optional) {
      const role = node.id === 'chatHistory' ? 'auto' : node.id === 'userInput' ? 'user' : 'system';
      if (node.kind !== (required ? 'system' : 'postprocess') || node.role !== role || (required && !node.enabled)) return '系统节点的角色和启用规则不能更改。';
    } else if (node.kind !== 'text' || !['system', 'user', 'assistant'].includes(node.role)) {
      return '请检查自定义节点的消息角色。';
    }
  }
  if (systemIds.some(id => !ids.has(id))) return '预设缺少必需的系统节点。';
  const builtinOrder = preset.nodes.filter(node => node.kind !== 'text').map(node => node.id);
  if (builtinOrder.join(',') !== [...systemIds, ...postprocessIds.filter(id => ids.has(id))].join(',')) return '请保持系统节点的先后顺序。';
  return null;
}

export function presetInput(preset: StudioPreset):PresetInput {
  return {
    type:'narrative',name:preset.name.trim(),description:preset.description,
    config:{
      schemaVersion:1,nodes:preset.nodes.map(({id,name,kind,role,enabled,prompt})=>({id,name,kind,role,enabled,prompt})),
      contextStrategy:{strategy:preset.contextStrategy,maxContextTokens:preset.maxContextTokens,maxOutputTokens:preset.maxOutputTokens,summaryPrompt:preset.summaryPrompt},
      modelParameters:{...(preset.temperature===undefined?{}:{temperature:preset.temperature}),thinkingEnabled:preset.thinkingEnabled},
    },
  };
}
