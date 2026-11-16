import type { StudioPreset } from './types.js';

export function fromServer(raw: any): StudioPreset {
  const nodes = raw.config_json.nodes;
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description ?? '',
    contextStrategy: raw.context_strategy.strategy,
    maxContextTokens: raw.context_strategy.max_context_tokens,
    maxOutputTokens: raw.context_strategy.max_output_tokens,
    temperature: raw.model_parameters?.temperature ?? 1,
    thinkingEnabled: raw.model_parameters?.thinking_enabled ?? false,
    summaryPrompt: raw.context_strategy.summary_prompt,
    style: {
      content: nodes.find((node: any) => node.id === 'main')?.prompt.parts
        .filter((part: any) => part.type === 'text').map((part: any) => part.value).join('') ?? '',
      enabled: true,
    },
    customNodes: nodes.filter((node: any) => node.kind === 'text').map((node: any) => ({
      ...node,
      content: node.prompt.parts.filter((part: any) => part.type === 'text').map((part: any) => part.value).join(''),
    })),
    raw,
  };
}

export function getPresetValidationError(preset: StudioPreset): string | null {
  if (!preset.summaryPrompt.trim() || !preset.style.content.trim() || preset.customNodes.some(node => !node.content.trim())) return '提示词不能为空。';
  if (!preset.name.trim()) return '请输入预设名称。';
  if (!['rolling_summary', 'sliding_window'].includes(preset.contextStrategy)) return '请选择上下文策略。';
  if (!Number.isSafeInteger(preset.maxContextTokens) || preset.maxContextTokens < 2 || !Number.isSafeInteger(preset.maxOutputTokens) || preset.maxOutputTokens < 1) return '请输入有效的上下文和输出预算。';
  if (!Number.isFinite(preset.temperature) || preset.temperature < 0 || preset.temperature > 2) return '温度必须在 0 到 2 之间。';
  if (typeof preset.thinkingEnabled !== 'boolean') return '请选择是否开启深度思考。';
  const ids = new Set<string>();
  for (const node of preset.customNodes) {
    if (!node.id || ids.has(node.id) || !node.name.trim() || !['system', 'user', 'assistant'].includes(node.role)) return '请检查自定义节点名称、角色和 ID。';
    ids.add(node.id);
  }
  return null;
}

export function fields(preset: StudioPreset) {
  return {
    name: preset.name.trim(),
    description: preset.description,
    context_strategy: {
      strategy: preset.contextStrategy,
      max_context_tokens: preset.maxContextTokens,
      max_output_tokens: preset.maxOutputTokens,
      summary_prompt: preset.summaryPrompt,
    },
    model_parameters: { temperature: preset.temperature, thinking_enabled: preset.thinkingEnabled },
  };
}

export function presetPatch(preset: StudioPreset) {
  const text = (value: string) => ({ parts: [{ type: 'text', value }] });
  const fixed = preset.raw.config_json.nodes.filter((node: any) => node.kind !== 'text')
    .map((node: any) => node.id === 'main' ? { ...node, prompt: text(preset.style.content) } : node);
  const custom = preset.customNodes.map(node => ({
    id: node.id, kind: 'text', name: node.name, role: node.role, enabled: node.enabled, prompt: text(node.content),
  }));
  return { ...fields(preset), config_json: { schemaVersion: 2, nodes: [fixed[0], ...custom, ...fixed.slice(1)] } };
}
