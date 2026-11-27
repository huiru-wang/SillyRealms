export type ModelConfig = {
  id: string;
  name: string;
  providerId: string;
  modelId: string;
  credentialStatus: 'configured' | 'missing' | 'unavailable';
  createdAt: number;
  updatedAt: number;
};

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type CatalogModel = {
  providerId: string;
  modelId: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  api: string;
  input: Array<'text' | 'image'>;
  thinkingLevels: ThinkingLevel[];
  thinkingLevelMap: Partial<Record<ThinkingLevel, string | null>> | null;
  promptCache: { short: number | null; long: number | null } | null;
  supportsMidConversationSystemMessages: boolean;
};
export type ProviderModelGroup = { providerId: string; name: string; models: CatalogModel[] };
export type ModelCatalog = { items: ProviderModelGroup[] };
export type ModelDraft = {
  id?: string;
  name: string;
  providerId: string;
  modelId: string;
  apiKey: string;
  original?: { providerId: string; modelId: string };
};

export type ModelConnectionUsage={
  inputTokens:number;outputTokens:number;totalTokens:number;cacheReadTokens:number;cacheWriteTokens:number;
};
export type ModelConnectionResult={
  providerId:string;modelId:string;connected:true;durationMs:number;usage:ModelConnectionUsage|null;
};
