import { AppError } from '../../errors.js';
import { captureNarrativeContext } from './capture.js';
import { createCandidateEvaluator } from './candidate.js';
import { compactHistory } from './stages/compact/index.js';
import type { ContextDependencies, ContextFailure, ContextProgress, PrepareContextInput, PreparedContext, SummaryReceipt } from './types.js';

function failure(error: unknown): ContextFailure {
  if (error === 'summary_failed') return { code: 'SUMMARY_FAILED' };
  if (error === 'summary_capacity_exceeded') return { code: 'SUMMARY_CAPACITY_EXCEEDED' };
  return { code: error instanceof AppError ? error.code : 'INTERNAL_ERROR' };
}
const assertRunning = (signal: AbortSignal) => {
  if (signal.aborted) throw new AppError('RUN_STOPPED');
};

/** Capture before the first await; all stages and summary persistence stay behind this entry. */
export async function prepareContext(dependencies: ContextDependencies, input: PrepareContextInput): Promise<PreparedContext> {
  const receipt: { parentEntryId: string; summary?: SummaryReceipt } = { parentEntryId: input.userEntryId };
  const notify = (progress: ContextProgress) => {
    try { input.onProgress?.(progress); } catch { /* Progress transport cannot erase a committed summary. */ }
  };
  try {
    const snapshot = captureNarrativeContext(dependencies, input);
    // The caller can schedule run.created before asynchronous preparation while capture remains synchronous.
    await Promise.resolve();
    assertRunning(input.signal);
    const model = dependencies.modelClient.resolve(snapshot.modelConfig.providerId, snapshot.modelConfig.modelId);
    const evaluateCandidate = createCandidateEvaluator(snapshot, model, dependencies.state);
    const result = await compactHistory({
      historyEntries: snapshot.historyEntries, contextStrategy: snapshot.preset.config.contextStrategy,
    }, model, evaluateCandidate, async request => {
      dependencies.modelClient.assertMessageOrder(model, request.messages);
      return dependencies.summarize({
        ...request, model, credentialRef: snapshot.modelConfig.credentialRef, signal: input.signal,
        temperature: snapshot.preset.config.modelParameters.temperature,
        thinkingEnabled: snapshot.preset.config.modelParameters.thinkingEnabled,
        thinkingLevel: snapshot.preset.config.modelParameters.thinkingLevel,
        onStarted: () => notify({ type: 'summary_started' }),
      });
    }, input.signal);
    assertRunning(input.signal);
    if (result.summaryDraft) {
      const draft = result.summaryDraft;
      let entry;
      try {
        entry = dependencies.sessions.appendEntry(input.sessionId, {
          parentId: input.userEntryId, runId: input.runId, type: 'compaction', role: null,
          payload: { summary: draft.text }, state: null, metrics: draft.metrics,
          extData: { summary: { coveredThroughEntryId: draft.coveredThroughEntryId, sourceHash: draft.sourceHash } },
        }, input.writePermit);
      } catch (error) {
        if (error instanceof AppError && (error.code === 'TIP_CONFLICT' || error.code === 'SESSION_NOT_FOUND')) throw error;
        throw new AppError('MESSAGE_PERSIST_FAILED');
      }
      receipt.parentEntryId = entry.id;
      receipt.summary = { entryId: entry.id, metrics: entry.metrics };
      notify({ type: 'summary_saved', entryId: entry.id });
    }
    // Cancellation or a late preparation failure must retain the already committed receipt.
    assertRunning(input.signal);
    if (result.failure !== undefined) return { ...receipt, ok: false, failure: failure(result.failure) };
    dependencies.modelClient.assertMessageOrder(model, result.compiled.messages);
    const { diagnostics, ...request } = result.compiled;
    return { ...receipt, ok: true, diagnostics, request: {
      ...request, model, credentialRef: snapshot.modelConfig.credentialRef,
    } };
  } catch (error) {
    return { ...receipt, ok: false, failure: failure(error) };
  }
}
