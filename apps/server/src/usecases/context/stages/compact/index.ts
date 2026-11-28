import { AppError } from '../../../../errors.js';
import type { ModelInfo, ModelMessage } from '../../../../infrastructure/model/client.js';
import type { RequestMetrics } from '../../../../modules/sessions/service.js';
import type { CompiledNarrativeContext } from '../assemble/index.js';
import { planContext, type CandidateEvaluator, type CompactInput } from './plan.js';

export type SummaryRequest = { messages: ModelMessage[]; maxTokens: number };
export type SummaryOutcome = { ok: true; text: string; metrics: RequestMetrics | null } | { ok: false };
export type Summarize = (request: SummaryRequest) => Promise<SummaryOutcome>;
export type SummaryDraft = {
  text: string;
  coveredThroughEntryId: string;
  sourceHash: string;
  metrics: RequestMetrics | null;
};
export type CompactedContext = {
  compiled: CompiledNarrativeContext;
  summaryDraft?: SummaryDraft;
  /** A successful summary draft survives a later candidate compilation or capacity failure. */
  failure?: unknown;
};

/** Select history and, at most once, summarize it. The caller owns storage and progress events. */
export async function compactHistory(
  input: CompactInput,
  model: Pick<ModelInfo, 'contextWindow' | 'maxTokens'>,
  evaluateCandidate: CandidateEvaluator,
  summarize: Summarize,
  signal: AbortSignal,
): Promise<CompactedContext> {
  if (signal.aborted) throw new AppError('RUN_STOPPED');
  const plan = planContext(input, model, evaluateCandidate);
  if (!plan.summary) return { compiled: plan.compiled };
  const result = await summarize({ messages: plan.summary.messages, maxTokens: plan.summary.maxTokens });
  if (signal.aborted) throw new AppError('RUN_STOPPED');
  if (!result.ok || !result.text.trim()) return { compiled: plan.compiled, failure: 'summary_failed' };
  const summaryDraft: SummaryDraft = {
    text: result.text,
    coveredThroughEntryId: plan.summary.coveredThroughEntryId,
    sourceHash: plan.summary.sourceHash,
    metrics: result.metrics,
  };
  try {
    const retained = input.historyEntries.filter(entry => entry.type === 'message').slice(plan.summary.coveredCount);
    const compiled = evaluateCandidate(retained, result.text);
    return {
      compiled, summaryDraft,
      ...(compiled.estimatedInputTokens > compiled.inputBudget ? { failure: 'summary_capacity_exceeded' } : {}),
    };
  } catch (error) {
    return { compiled: plan.compiled, summaryDraft, failure: error };
  }
}
