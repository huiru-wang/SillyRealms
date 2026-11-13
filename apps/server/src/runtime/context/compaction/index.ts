import { fraction } from '../../../domain/preset-budget.js';
import { ESTIMATOR_VERSION, estimateContext, estimateHistory, estimateInitial } from './estimator.js';
import { rollingSummary } from './rolling-summary.js';
import { selectSuffix } from './sliding-window.js';
import type { CompactionInput, CompactionResult, PreparationReport } from './types.js';

/** The only history-reduction entry point: called once, before main generation. */
export async function prepareForRun(input: CompactionInput): Promise<CompactionResult> {
  const { policy } = input, strategy = policy.budget.strategy;
  const uncovered = input.oldSummary ? input.history.slice(input.history.findIndex(h => h.id === input.oldSummary!.coveredThroughEntryId) + 1) : input.history;
  const initial = strategy === 'rolling_summary' ? [...(input.oldSummary ? [{ id: 'summary', role: 'assistant' as const, text: input.oldSummary.text }] : []), ...uncovered] : input.history;
  const before = input.preview(initial), estimated = estimateInitial(before, input.identity(before), input.baseline);
  const fixedTokensBefore = Math.max(0, estimateContext(before) - estimateHistory(initial));
  const target = fraction(policy.budget.max_context_tokens, 60);
  const report: PreparationReport = { strategy, estimatorVersion: ESTIMATOR_VERSION, method: estimated.method,
    baselineReason: estimated.baselineReason, estimatedInputBefore: estimated.tokens, estimatedInputAfter: estimateContext(before),
    threshold: policy.budget.max_context_tokens, target, triggered: estimated.tokens >= policy.budget.max_context_tokens,
    outcome: 'unchanged', targetExceeded: estimateContext(before) > target, omittedTurnCount: 0,
    fixedTokensBefore, fixedTokensAfter: fixedTokensBefore };
  if (!report.triggered) return { history: initial, report };
  const reserve = fixedTokensBefore;
  let history = initial;
  let summary: CompactionResult['summary'];
  if (strategy === 'sliding_window') {
    const selection = selectSuffix(input.history, Math.max(0, target - reserve));
    history = selection.kept; report.omittedTurnCount = selection.omittedTurnCount;
    report.outcome = 'trimmed'; report.firstKeptEntryId = history[0]?.id;
    if (reserve > target) report.reason = 'protected_over_target';
  } else {
    const result = await rollingSummary(input, uncovered, Math.max(0, target - reserve - policy.summary.maxOutputTokens - 16));
    if (!result) { report.outcome = 'skipped'; report.reason = 'no_eligible_history'; }
    else {
      const candidate = [{ id: 'summary', role: 'assistant' as const, text: result.summary.text }, ...result.kept];
      if (estimateContext(input.preview(candidate)) >= estimateContext(before)) {
        report.outcome = 'skipped'; report.reason = 'no_reduction';
      } else {
        history = candidate; summary = result.summary; report.outcome = 'summarized';
        report.omittedTurnCount = result.omittedTurnCount; report.firstKeptEntryId = result.kept[0]?.id;
      }
    }
  }
  report.estimatedInputAfter = estimateContext(input.preview(history));
  report.fixedTokensAfter = Math.max(0, report.estimatedInputAfter - estimateHistory(history));
  report.targetExceeded = report.estimatedInputAfter > target;
  if (report.targetExceeded && !report.reason) report.reason = reserve + estimateHistory(history) > target
    ? 'protected_over_target' : 'activation_over_target';
  return { history, summary, report };
}
