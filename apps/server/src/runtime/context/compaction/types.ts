import type { Context } from '@earendil-works/pi-ai';
import type { ContextPolicy, SummaryCandidate } from '../../types.js';
import type { HistoryItem } from './history.js';
import type { InputBaseline, InputIdentity } from './estimator.js';
export type PreparationReport = {
  strategy: ContextPolicy['budget']['strategy']; estimatorVersion: string;
  method: 'usage_plus_estimate' | 'full_estimate'; baselineReason?: string;
  estimatedInputBefore: number; estimatedInputAfter: number; threshold: number; target: number;
  triggered: boolean; outcome: 'unchanged' | 'summarized' | 'trimmed' | 'skipped';
  reason?: 'no_eligible_history' | 'no_reduction' | 'protected_over_target' | 'activation_over_target';
  targetExceeded: boolean; omittedTurnCount: number; firstKeptEntryId?: string;
  fixedTokensBefore: number; fixedTokensAfter: number;
};
export type CompactionInput = {
  history: HistoryItem[]; oldSummary?: SummaryCandidate; policy: ContextPolicy;
  preview: (history: HistoryItem[]) => Context;
  identity: (context: Context) => InputIdentity; baseline?: InputBaseline;
  summarize: (previous: string | null, history: HistoryItem[]) => Promise<string>;
};
export type CompactionResult = { history: HistoryItem[]; summary?: SummaryCandidate; report: PreparationReport };
