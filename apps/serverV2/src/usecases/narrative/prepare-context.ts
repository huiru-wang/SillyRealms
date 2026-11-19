import { AppError } from '../../errors.js';
import type { ModelInfo } from '../../infrastructure/model/client.js';
import type { SessionEntry } from '../../modules/sessions/service.js';
import type { StateService } from '../../modules/state/service.js';
import { compileNarrativeContext, type CompiledNarrativeContext } from './compile.js';
import { contextBudget, summaryBudget } from './context-policy.js';
import type { NarrativeSnapshot } from './context.js';
import type { NarrativeStopReason } from './events.js';
import { historyBoundaries, projectHistory, readSummary, sourceHash } from './history.js';
import { selectNarrativeMaterials } from './materials.js';
import { assertRunning, callModel, cancellationReason, failureReason } from './model-call.js';
import { summaryRequest } from './summary.js';
import type { NarrativeDependencies, NarrativeExecution } from './types.js';

type ContextPlan = {
  compiled: CompiledNarrativeContext;
  summary?: ReturnType<typeof summaryRequest> & { coveredCount: number; sourceHash: string; coveredThroughEntryId: string };
};
function compileCandidate(snapshot: NarrativeSnapshot, model: Pick<ModelInfo, 'contextWindow' | 'maxTokens'>, state: Pick<StateService, 'evaluateWhen'>,
  entries: readonly SessionEntry[], summary: string): CompiledNarrativeContext {
  const history = projectHistory(entries);
  return compileNarrativeContext({ ...snapshot, history, materials: selectNarrativeMaterials({
    world: snapshot.world, views: snapshot.views, playerId: snapshot.session.userCharacterId,
    inputText: snapshot.inputText, history, summary,
  }, state) }, model);
}

/** Pure selection over captured inputs. Every candidate re-evaluates keyword-dependent materials. */
export function planContext(snapshot: NarrativeSnapshot, model: Pick<ModelInfo, 'contextWindow' | 'maxTokens'>, state: Pick<StateService, 'evaluateWhen'>): ContextPlan {
  const messages = snapshot.historyEntries.filter(entry => entry.type === 'message');
  const rolling = snapshot.preset.config.contextStrategy.strategy === 'rolling_summary';
  const previous = rolling ? readSummary(snapshot.historyEntries, messages) : null;
  const covered = previous?.coveredCount ?? 0;
  const compiled = compileCandidate(snapshot, model, state, messages.slice(covered), previous?.text ?? '');
  const { inputBudget, target } = contextBudget(snapshot.preset.config, model);
  if (compiled.estimatedInputTokens < inputBudget) return { compiled };
  const boundaries = historyBoundaries(messages);
  if (!rolling) {
    let fallback: CompiledNarrativeContext | undefined;
    for (const count of boundaries) {
      const candidate = compileCandidate(snapshot, model, state, messages.slice(count), '');
      if (candidate.estimatedInputTokens <= target) return { compiled: candidate };
      if (!fallback && candidate.estimatedInputTokens <= inputBudget) fallback = candidate;
    }
    if (fallback) return { compiled: fallback };
    throw new AppError('CONTEXT_BUDGET_EXCEEDED');
  }

  const candidates = boundaries.filter(count => count > covered &&
    new Set(messages.slice(count).map(entry => entry.runId)).size >= 5);
  if (!candidates.length) {
    if (compiled.estimatedInputTokens <= inputBudget) return { compiled };
    throw new AppError('SUMMARY_CAPACITY_EXCEEDED');
  }
  let coveredCount = candidates.at(-1)!;
  // Reserve the summary's output allowance while choosing the longest recent suffix near the soft target.
  const placeholder = 's'.repeat(summaryBudget(model).maxTokens * 3);
  for (const count of candidates) {
    if (compileCandidate(snapshot, model, state, messages.slice(count), placeholder).estimatedInputTokens <= target) {
      coveredCount = count;
      break;
    }
  }
  const request = summaryRequest(model, snapshot.preset.config.contextStrategy.summaryPrompt,
    previous?.text ?? '', projectHistory(messages.slice(covered, coveredCount)));
  return { compiled, summary: {
    ...request, coveredCount, coveredThroughEntryId: messages[coveredCount - 1]!.id,
    sourceHash: sourceHash(messages.slice(0, coveredCount)),
  } };
}

type PreparedContext = { compiled: CompiledNarrativeContext; summary?: SessionEntry; stopReason?: NarrativeStopReason };

/** Persist only a complete summary; a failed or cancelled summary has no entry or accounting. */
export async function prepareContext(dependencies: NarrativeDependencies, execution: NarrativeExecution,
  snapshot: NarrativeSnapshot, model: ModelInfo, apiKey: string, plan: ContextPlan): Promise<PreparedContext> {
  if (!plan.summary) return { compiled: plan.compiled };
  const { sessionId, runId, userEntryId, signal } = execution;
  const { sessions, modelClient, events, state } = dependencies;
  const fields = () => ({ sessionId, runId, provider: model.providerId, model: model.modelId, timestamp: Date.now() });
  assertRunning(signal);
  events.publish(sessionId, { event: 'run.summarizing', data: fields() });
  const result = await callModel(modelClient, model, plan.summary.messages, {
    apiKey, signal, maxTokens: plan.summary.maxTokens,
    temperature: snapshot.preset.config.modelParameters.temperature,
    thinkingEnabled: snapshot.preset.config.modelParameters.thinkingEnabled,
  });
  if (signal.aborted) return { compiled: plan.compiled, stopReason: cancellationReason(signal) };
  if (result.stopReason || !result.attempted) return { compiled: plan.compiled, stopReason: 'summary_failed' };
  let entry: SessionEntry;
  try {
    entry = sessions.appendEntry(sessionId, {
      parentId: userEntryId, runId, type: 'compaction', role: null,
      payload: { summary: result.snapshot.content }, state: null, metrics: result.metrics,
      extData: { summary: { coveredThroughEntryId: plan.summary.coveredThroughEntryId, sourceHash: plan.summary.sourceHash } },
    });
  } catch (error) {
    if (error instanceof AppError && (error.code === 'TIP_CONFLICT' || error.code === 'SESSION_NOT_FOUND')) throw error;
    throw new AppError('MESSAGE_PERSIST_FAILED');
  }
  events.publish(sessionId, { event: 'run.summarized', data: { ...fields(), entryId: entry.id } });
  try {
    const messages = snapshot.historyEntries.filter(item => item.type === 'message').slice(plan.summary.coveredCount);
    const compiled = compileCandidate(snapshot, model, state, messages, result.snapshot.content);
    return { compiled, summary: entry,
      ...(compiled.estimatedInputTokens > compiled.inputBudget ? { stopReason: 'summary_capacity_exceeded' as const } : {}),
    };
  } catch (error) {
    // A committed summary and its accounting survive any later preparation failure.
    return { compiled: plan.compiled, summary: entry, stopReason: failureReason(error, false) };
  }
}
