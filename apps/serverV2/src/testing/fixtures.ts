import type { CreatePresetInput } from '../presets/service.js';

export function narrativePreset(name = 'Story'): CreatePresetInput {
  return {
    type: 'narrative', name, description: 'Narrative preset',
    config: {
      schemaVersion: 1,
      nodes: ['main', 'personaInfo', 'characterInfo', 'worldInfo', 'chatHistory', 'userInput'].map(id => ({
        id, name: id, kind: 'system' as const, enabled: true,
        role: id === 'chatHistory' ? 'auto' as const : id === 'userInput' ? 'user' as const : 'system' as const,
        prompt: id === 'chatHistory' ? '{{history.messages}}' : id === 'userInput' ? '{{input.text}}' : '',
      })),
      contextStrategy: {
        strategy: 'rolling_summary', maxContextTokens: 30000,
        maxOutputTokens: 4096, summaryPrompt: 'Summarize earlier history',
      },
      modelParameters: { thinkingEnabled: false, temperature: 1 },
    },
  };
}
