/** Content-free receipts from the actual final candidate, for run observability. */
export type ContextMaterialDiagnostic = {
  id: string;
  name: string;
  role?: 'persona' | 'character';
  condition: {
    enabled: boolean;
    load: {
      mode?: 'always' | 'on_mention' | 'never';
      keywords?: string[];
      keyword_logic?: 'any' | 'all';
      exclude_keywords?: string[];
      when?: string;
      order?: number;
    };
  };
  matched: boolean;
  reason: 'matched' | 'disabled' | 'never' | 'invalid_rule' | 'excluded' | 'keyword_unmatched' | 'when_false' | 'when_evaluation_failed';
  /** Present only when keyword matching was actually evaluated. */
  keywordMatch?: { logic: 'any' | 'all'; matchedKeywords: string[]; excludedKeywords: string[]; result: boolean };
  /** Present only when the condition evaluator was actually called. */
  whenMatch?: { result: boolean | null; error?: 'evaluation_failed' };
};
export type ContextNodeDiagnostic = {
  id: string;
  name: string;
  kind: 'system' | 'postprocess' | 'text' | 'protocol';
  role: 'system' | 'user' | 'assistant' | 'auto';
  /** Configured flag; built-in postprocess nodes deliberately ignore legacy enabled. */
  enabled: boolean;
  included: boolean;
  reason: 'included' | 'disabled' | 'empty' | 'no_active_state';
  source: 'preset' | 'default' | 'fallback' | 'platform';
  /** Zero-based positions in the final model request, not log line numbers. */
  messageIndexes: number[];
  modelNoteEntryIds?: string[];
};
export type ContextDiagnostics = {
  nodes: ContextNodeDiagnostic[];
  characters: ContextMaterialDiagnostic[];
  lore: ContextMaterialDiagnostic[];
  activeRoots: string[];
  messageCount: number;
  estimatedInputTokens: number;
  inputBudget: number;
};
