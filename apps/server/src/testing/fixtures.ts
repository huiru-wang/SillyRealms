import type { CreatePresetInput } from '../modules/presets/service.js';

export function narrativePreset(name = 'Story'): CreatePresetInput {
  return {
    type: 'narrative', name, description: 'Narrative preset',
    config: {
      schemaVersion: 1,
      nodes: [...['main', 'personaInfo', 'characterInfo', 'worldInfo', 'chatHistory', 'userInput'].map(id => ({
        id, name: id, kind: 'system' as const, enabled: true,
        role: id === 'chatHistory' ? 'auto' as const : id === 'userInput' ? 'user' as const : 'system' as const,
        prompt: id === 'chatHistory' ? '{{history.summary}}{{history.messages}}' : id === 'userInput' ? '{{input.text}}' : '',
      })),
      ...(['worldState', 'actionSuggestions', 'characterSprite'] as const).map(id => ({
        id, name: id, kind: 'postprocess' as const, role: 'system' as const, enabled: true,
        prompt: id === 'worldState' ? '{{state.global}}\n{{state.session}}\n{{state.message}}'
          : id === 'characterSprite' ? '基于 {{characterSprite.catalog}} 输出完整立绘快照。' : '生成下一步行动建议。',
      }))],
      contextStrategy: {
        strategy: 'rolling_summary', maxContextTokens: 30000,
        maxOutputTokens: 4096, summaryPrompt: 'Summarize earlier history',
      },
      modelParameters: { thinkingEnabled: false, temperature: 1 },
    },
  };
}

export function withEmptyModelNotes(body: string): string {
  return body + '\n\n<action_suggestions>[]</action_suggestions>';
}
