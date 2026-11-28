import { AppError } from '../../errors.js';
import type { ModelFinishReason, ModelSnapshot } from '../../infrastructure/model/client.js';
import { processNarrativeOutput } from './postprocess/processor.js';
import type { RequestMetrics } from '../../modules/sessions/service.js';
import type { CharacterSpriteCatalogItem } from '../../modules/worlds/service.js';
import type { NarrativeEvent, NarrativeSettlement, NarrativeStopReason, RunEventFields } from './events.js';
import type { NarrativeDependencies, NarrativeExecution } from './types.js';
import { assertRunning, callModel, cancellationReason, copySnapshot, failureReason, hasPublicOutput } from './model-call.js';

/** User-first execution, optional single summary, then narrative and one settlement. */
export async function executeNarrative(dependencies: NarrativeDependencies, execution: NarrativeExecution): Promise<NarrativeSettlement | null> {
  const { sessions, modelClient, events } = dependencies;
  const { sessionId, runId, userEntryId, assistantEntryId, userMessage, tipEntryId: acceptedTipEntryId, deletedMessageIds, provider, model, prepared, getApiKey, signal, log, writePermit } = execution;
  let snapshot: ModelSnapshot = { role: 'assistant', content: '', reasoning_content: '', tool_calls: [] };
  let attempted = false, receivedTerminal = false, publishedDelta = false;
  let metrics: RequestMetrics | null = null;
  let finishReason: ModelFinishReason | undefined, stopReason: NarrativeStopReason | undefined;
  let parentId = acceptedTipEntryId ?? userEntryId;
  let rawContent = '', allowedStateUpdateRoots: string[] = [];
  let characterSpriteCatalog: readonly CharacterSpriteCatalogItem[] = [];
  const fields = (): RunEventFields => ({ runId, assistantEntryId, sessionId, provider, model, timestamp: Date.now() });
  const publish = (event: NarrativeEvent) => {
    try { events.publish(sessionId, event); } catch { /* Delivery is independent of storage. */ }
  };
  publish({ event: 'run.created', data: { ...fields(), messages: [{ ...userMessage }], tipEntryId: acceptedTipEntryId, deletedMessageIds } });
  try {
    assertRunning(signal);
    const context = await prepared;
    if (context.ok) log('context.completed', { ...context.diagnostics, parentEntryId: context.parentEntryId,
      summaryEntryId: context.summary?.entryId ?? null });
    else log('context.failed', { failure: context.failure, parentEntryId: context.parentEntryId,
      summaryEntryId: context.summary?.entryId ?? null });
    if (context.parentEntryId !== null) parentId = context.parentEntryId;
    assertRunning(signal);
    if (!context.ok) {
      stopReason = context.failure.code === 'SUMMARY_FAILED'
        ? 'summary_failed' : failureReason(new AppError(context.failure.code), false);
    }
    if (context.ok) {
      const compiled = context.request, selected = compiled.model;
      allowedStateUpdateRoots = compiled.allowedStateUpdateRoots;
      characterSpriteCatalog = compiled.characterSpriteCatalog;
      const apiKey = await getApiKey(compiled.credentialRef);
      assertRunning(signal);
      const result = await callModel(modelClient, selected, compiled.messages, {
        apiKey, signal, maxTokens: compiled.maxTokens,
        ...compiled.modelParameters,
        onDiagnostic(event) {
          log('model.' + event.type, { purpose: 'narrative', provider: selected.providerId,
            model: selected.modelId, source: event.source, raw: event.data });
        },
      }, { events, fields: fields(), messageId: assistantEntryId });
      ({ snapshot, rawContent, attempted, metrics, finishReason, stopReason, receivedTerminal, publishedDelta } = result);
      if (metrics && metrics.requests.length) {
        metrics = { ...metrics, context: { ...compiled.context, requestId: metrics.requests.at(-1)!.requestId } };
      }
    }
  } catch (error) {
    stopReason = signal.aborted ? cancellationReason(signal) : failureReason(error, attempted);
  }

  if (signal.aborted) stopReason = cancellationReason(signal);
  if (receivedTerminal || publishedDelta || hasPublicOutput(snapshot)) {
    publish({ event: 'run.delta', data: {
      ...fields(), messageId: assistantEntryId, messages: [{
        role: 'assistant', delta: {}, snapshot: copySnapshot(snapshot),
        ...(finishReason === undefined ? {} : { finish_reason: finishReason }),
      }],
    } });
  }
  // A final-snapshot observer can still cancel before persistence begins.
  if (signal.aborted) stopReason = cancellationReason(signal);

  let receipt;
  try {
    receipt = dependencies.transaction(() => {
      if (sessions.require(sessionId).tipEntryId !== parentId) throw new AppError('TIP_CONFLICT');
      const timestamp = Date.now();
      const reply = hasPublicOutput(snapshot) ? {
        id: assistantEntryId, parentId, timestamp, payload: { message: { ...copySnapshot(snapshot), timestamp } },
      } : null;
      let processed;
      if (reply && !stopReason) {
        log('postprocess.started', { messageId: assistantEntryId, allowedRoots: allowedStateUpdateRoots });
        processed = processNarrativeOutput(rawContent, dependencies.state, {
          sessionId, parentId, allowedRoots: allowedStateUpdateRoots, characterSpriteCatalog,
        }, (event, data) => log(event, { messageId: assistantEntryId, ...data }));
      }
      const saved = sessions.settleRun(sessionId, runId, assistantEntryId, stopReason ?? null,
        reply ? { ...reply, state: processed?.state ?? null } : null, processed?.output ?? null, metrics, writePermit);
      return { saved, processed };
    });
  } catch (error) {
    if (error instanceof AppError && (error.code === 'RUN_NOT_FOUND' || error.code === 'SESSION_NOT_FOUND' || error.code === 'SESSION_WRITE_LOCKED')) {
      log('run.discarded', { stop_reason: error.code === 'SESSION_NOT_FOUND' ? 'session_deleted' : 'tip_conflict' });
      return null;
    }
    stopReason = error instanceof AppError && error.code === 'TIP_CONFLICT' ? 'tip_conflict' : 'message_persist_failed';
    log('message.persist_failed', { messageId: assistantEntryId, persisted: false, stop_reason: stopReason });
    const invalidMetrics = error instanceof AppError &&
      (error.code === 'INVALID_REQUEST_METRICS' || error.code === 'DUPLICATE_REQUEST_METRICS');
    const saved = sessions.settleRun(sessionId, runId, assistantEntryId, stopReason, null, null, invalidMetrics ? null : metrics, writePermit);
    receipt = { saved, processed: undefined };
  }
  const { saved, processed } = receipt;
  const notifications: NarrativeSettlement['notifications'] = [];
  if (processed) {
    const { change, output } = processed;
    const suggestions = output.actionSuggestions.items;
    const sprites = output.characterSprite;
    const applySprites = sprites?.status === 'success' || sprites?.status === 'partial_success';
    if (change) notifications.push(change);
    if (suggestions.length) notifications.push({ event: 'action_suggestions.created',
      data: { sessionId, runId, messageId: assistantEntryId, items: suggestions } });
    if (applySprites) notifications.push({ event: 'character_sprite.changed',
      data: { sessionId, runId, messageId: assistantEntryId, items: sprites.items } });
    log('postprocess.completed', { messageId: assistantEntryId, persisted: true, stateChanged: change !== null,
      suggestionCount: suggestions.length, ...(applySprites && { characterSpriteCount: sprites.items.length }) });
  }
  const usageEvent: NarrativeSettlement['usage'] = { event: 'run.usage', data: { ...fields(), usage: saved.usage } };
  const data = { ...fields(), savedMessageIds: saved.savedMessageIds, tipEntryId: saved.tipEntryId };
  return {
    notifications,
    usage: usageEvent,
    terminal: saved.stopReason === null
      ? { event: 'run.completed', data }
      : { event: 'run.stopped', data: { ...data, stop_reason: saved.stopReason } },
  };
}
