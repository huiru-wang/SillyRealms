import type { SamplingDraft, SamplingKey } from './sampling';
export type PresetThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
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
export type PresetType = 'narrative' | 'reply_assist';
export type WebPreset = SamplingDraft & {
  id: string;
  type: PresetType;
  apiModelConfigId?: string|null;
  name: string;
  description: string;
  contextStrategy: ContextStrategy;
  maxContextTokens: number;
  maxOutputTokens: number;
  thinkingEnabled: boolean;
  thinkingLevel?: PresetThinkingLevel;
  summaryPrompt: string;
  nodes: PresetNode[];
  revision: number;
};

export type PresetSummary={id:string;type:PresetType;name:string;description:string|null;revision:number;createdAt:number;updatedAt:number};
export type PresetInput={
  apiModelConfigId?:string|null;
  type:PresetType;name:string;description:string|null;
  config:{schemaVersion:1;nodes:PresetNode[];contextStrategy:{strategy:ContextStrategy;maxContextTokens:number;maxOutputTokens:number;summaryPrompt:string};modelParameters:Partial<Record<SamplingKey, number>> & {thinkingEnabled:boolean;thinkingLevel?:PresetThinkingLevel}};
};
export type PresetDetail=PresetSummary & PresetInput;
