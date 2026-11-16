export type ContextStrategy = 'rolling_summary' | 'sliding_window';
export type PresetRole = 'system' | 'user' | 'assistant' | 'auto';
export type PresetNode = {
  id: string;
  name: string;
  kind: 'system' | 'postprocess' | 'text';
  role: PresetRole;
  prompt: string;
  enabled: boolean;
};
export type StudioPreset = {
  id: string;
  name: string;
  description: string;
  contextStrategy: ContextStrategy;
  maxContextTokens: number;
  maxOutputTokens: number;
  temperature: number;
  thinkingEnabled: boolean;
  summaryPrompt: string;
  nodes: PresetNode[];
  raw: Record<string, any>;
};
