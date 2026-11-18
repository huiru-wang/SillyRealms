import type { CreatePresetInput } from '../presets/service.js';

export function narrativePreset(name = 'Story'): CreatePresetInput {
  return {
    type: 'narrative', name, description: 'Narrative preset',
    config_json: {
      schema_version: 1,
      nodes: ['main', 'personaInfo', 'characterInfo', 'worldInfo', 'chatHistory', 'userInput'].map(id => ({
        id, name: id, kind: 'system' as const, enabled: true,
        role: id === 'chatHistory' ? 'auto' as const : id === 'userInput' ? 'user' as const : 'system' as const,
        prompt: id === 'chatHistory' ? '{{history.messages}}' : id === 'userInput' ? '{{input.text}}' : '',
      })),
      context_strategy: {
        strategy: 'rolling_summary', max_context_tokens: 30000,
        max_output_tokens: 4096, summary_prompt: 'Summarize earlier history',
      },
      model_parameters: { thinking_enabled: false, temperature: 1 },
    },
  };
}
