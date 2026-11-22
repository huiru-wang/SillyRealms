import { AppError } from '../../../../errors.js';
import type { ModelInfo } from '../../../../infrastructure/model/client.js';
import type { SessionEntry } from '../../../../modules/sessions/service.js';
import type { Preset } from '../../../../modules/presets/service.js';
import { contextBudget, summaryBudget } from '../../lib/budget.js';
import type { CompiledNarrativeContext } from '../assemble/index.js';
import { historyBoundaries, projectHistory } from '../history/index.js';
import { readSummary, sourceHash } from './saved-summary.js';
import { summaryRequest } from './summary-request.js';

export type CompactInput = {
  historyEntries: readonly SessionEntry[];
  contextStrategy: Preset['config']['contextStrategy'];
};
export type CandidateEvaluator = (entries: readonly SessionEntry[], summary: string) => CompiledNarrativeContext;
export type ContextPlan = {
  compiled: CompiledNarrativeContext;
  summary?: ReturnType<typeof summaryRequest> & { coveredCount: number; sourceHash: string; coveredThroughEntryId: string };
};
/** Pure selection over captured inputs. Every candidate re-evaluates keyword-dependent materials. */
export function planContext(input: CompactInput, model: Pick<ModelInfo, 'contextWindow' | 'maxTokens'>, evaluateCandidate: CandidateEvaluator): ContextPlan {
  const messages = input.historyEntries.filter(entry => entry.type === 'message');
  const last = messages.at(-1);
  // An unanswered user protects its entire run, regardless of the caller or trailing summaries.
  const pendingRunId = last?.role === 'user' ? last.runId : null;
  const protectedStart = pendingRunId === null ? messages.length : messages.findIndex(entry => entry.runId === pendingRunId);
  const rolling = input.contextStrategy.strategy === 'rolling_summary';
  const previous = rolling ? readSummary(input.historyEntries, messages, protectedStart) : null;
  const covered = previous?.coveredCount ?? 0;
  const compiled = evaluateCandidate(messages.slice(covered), previous?.text ?? '');
  const { inputBudget, target } = contextBudget(input, model);
  if (compiled.estimatedInputTokens < inputBudget) return { compiled };
  const boundaries = historyBoundaries(messages).filter(count => count <= protectedStart);
  if (!rolling) {
    let fallback: CompiledNarrativeContext | undefined;
    for (const count of boundaries) {
      const candidate = evaluateCandidate(messages.slice(count), '');
      if (candidate.estimatedInputTokens <= target) return { compiled: candidate };
      if (!fallback && candidate.estimatedInputTokens <= inputBudget) fallback = candidate;
    }
    if (fallback) return { compiled: fallback };
    throw new AppError('CONTEXT_BUDGET_EXCEEDED');
  }

  const candidates = boundaries.filter(count => count > covered &&
    new Set(messages.slice(count).filter(entry => entry.runId !== pendingRunId).map(entry => entry.runId)).size >= 5);
  if (!candidates.length) {
    if (compiled.estimatedInputTokens <= inputBudget) return { compiled };
    throw new AppError('SUMMARY_CAPACITY_EXCEEDED');
  }
  let coveredCount = candidates.at(-1)!;
  // Reserve the summary's output allowance while choosing the longest recent suffix near the soft target.
  const placeholder = 's'.repeat(summaryBudget(model).maxTokens * 3);
  for (const count of candidates) {
    if (evaluateCandidate(messages.slice(count), placeholder).estimatedInputTokens <= target) {
      coveredCount = count;
      break;
    }
  }
  const request = summaryRequest(model, input.contextStrategy.summaryPrompt,
    previous?.text ?? '', projectHistory(messages.slice(covered, coveredCount)));
  return { compiled, summary: {
    ...request, coveredCount, coveredThroughEntryId: messages[coveredCount - 1]!.id,
    sourceHash: sourceHash(messages.slice(0, coveredCount)),
  } };
}
