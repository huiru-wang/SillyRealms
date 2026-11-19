/** Application-owned model boundary. No SDK objects or provider response blobs cross it. */
export type ModelThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ModelThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;

export type ModelInfo = {
  providerId: string; modelId: string; name: string; contextWindow: number; maxTokens: number;
  api: string; input: ('text' | 'image')[]; reasoning: boolean;
  thinkingLevels: ModelThinkingLevel[];
  thinkingLevelMap: ModelThinkingLevelMap | null;
  /** Catalog estimates in seconds; not the selected request cache policy. */
  promptCache: { short: number | null; long: number | null } | null;
  narrativeCompatible: boolean; supportsMidConversationSystemMessages: boolean;
};
export type ProviderInfo = { providerId: string; name: string; models: ModelInfo[] };

export type ModelToolCall = {
  /** Position among this message's tools, independent of provider content indices. */
  index: number;
  /** May still be empty in an interrupted, incomplete tool call. */
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};
/** id/name replace earlier values; only function.arguments is an append fragment. */
export type ModelToolCallDelta = {
  index: number; id?: string; type?: 'function';
  function?: { name?: string; arguments?: string };
};
export type ModelSnapshot = {
  role: 'assistant';
  content: string;
  reasoning_content: string;
  tool_calls: ModelToolCall[];
};
export type ModelDelta = {
  role?: 'assistant';
  content?: string;
  reasoning_content?: string;
  tool_calls?: ModelToolCallDelta[];
};
export type ModelToolResultMessage = {
  role: 'tool'; content: string; tool_call_id: string; name: string; is_error?: boolean; timestamp?: number;
};
export type ModelMessage =
  | { role: 'system' | 'user'; content: string; timestamp?: number }
  | { role: 'assistant'; content: string; reasoning_content?: string; tool_calls?: ModelToolCall[]; timestamp?: number }
  | ModelToolResultMessage;

export type ModelUsage = {
  /** Total input, including cache reads and writes. */
  inputTokens: number;
  /** Total output, already including provider-reported reasoning tokens. */
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};
export type ModelFinishReason = 'stop' | 'length' | 'tool_calls' | 'deferred';
export type ModelStopReason = 'aborted' | 'provider_error' | 'context_window_exceeded' | 'invalid_output' | 'incomplete_output';
export type ModelEvent =
  /** First event after beginning an SDK invocation attempt, without awaiting provider I/O; does not assert network delivery. */
  | { type: 'request_started' }
  | { type: 'delta'; delta: ModelDelta }
  /** Snapshot replaces accumulated public content; it is not another append delta. */
  | { type: 'done'; snapshot: ModelSnapshot; finishReason: ModelFinishReason; usage: ModelUsage | null }
  | { type: 'error'; snapshot: ModelSnapshot; stopReason: ModelStopReason; usage: ModelUsage | null };
export type ModelOptions = {
  apiKey: string; signal: AbortSignal; maxTokens: number; temperature?: number; thinkingEnabled?: boolean;
};
export interface ModelClient {
  listProviders(): ProviderInfo[];
  resolve(providerId: string, modelId: string): ModelInfo;
  assertMessageOrder(model: ModelInfo, messages: readonly ModelMessage[]): void;
  stream(model: ModelInfo, messages: readonly ModelMessage[], options: ModelOptions): AsyncIterable<ModelEvent>;
}
