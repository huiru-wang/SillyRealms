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
export type WebPreset = {
  id: string;
  name: string;
  description: string;
  contextStrategy: ContextStrategy;
  maxContextTokens: number;
  maxOutputTokens: number;
  temperature: number | undefined;
  thinkingEnabled: boolean;
  summaryPrompt: string;
  nodes: PresetNode[];
  revision: number;
};

export type PresetSummary={id:string;type:'narrative';name:string;description:string|null;revision:number;createdAt:number;updatedAt:number};
export type PresetInput={
  type:'narrative';name:string;description:string|null;
  config:{schemaVersion:1;nodes:PresetNode[];contextStrategy:{strategy:ContextStrategy;maxContextTokens:number;maxOutputTokens:number;summaryPrompt:string};modelParameters:{temperature?:number;thinkingEnabled:boolean}};
};
export type PresetDetail=PresetSummary & PresetInput;
