import { AppError } from '../../errors.js';
import type { ModelFinishReason, ModelSnapshot, ModelUsage } from '../../infrastructure/model/client.js';
import type { EntryMetrics } from '../../modules/sessions/service.js';
import type { NarrativeEvent, NarrativeSettlement, NarrativeStopReason, RunEventFields } from './events.js';
import type { NarrativeDependencies, NarrativeExecution } from './types.js';
import { assertRunning, callModel, cancellationReason, copySnapshot, failureReason, hasPublicOutput, whileRunning, zeroUsage } from './model-call.js';
import { planContext, prepareContext } from './prepare-context.js';

function addUsage(left: ModelUsage | null, right: ModelUsage | null): ModelUsage | null {
  if (left === null || right === null) return null;
  return {
    inputTokens: left.inputTokens + right.inputTokens, outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens, cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
  };
}

/** User-first execution, optional single summary, then narrative and one settlement. */
export async function executeNarrative(dependencies: NarrativeDependencies, execution: NarrativeExecution): Promise<NarrativeSettlement> {
  const { sessions, credentials, modelClient, events } = dependencies;
  const { sessionId, runId, userEntryId, assistantEntryId, userMessage, provider, model, prepared, signal } = execution;
  let snapshot: ModelSnapshot = { role: 'assistant', content: '', reasoning_content: '', tool_calls: [] };
  let usage: ModelUsage | null = zeroUsage(), summaryUsage: ModelUsage | null = zeroUsage();
  let attempted = false, receivedTerminal = false, publishedDelta = false;
  let metrics: EntryMetrics | null = null;
  let finishReason: ModelFinishReason | undefined, stopReason: NarrativeStopReason | undefined;
  let parentId = userEntryId;
  const fields = (): RunEventFields => ({ runId, sessionId, provider, model, timestamp: Date.now() });
  const publish = (event: NarrativeEvent) => events.publish(sessionId, event);
  publish({ event: 'run.created', data: { ...fields(), messages: [{ ...userMessage }] } });
  try {
    assertRunning(signal);
    if ('error' in prepared) throw prepared.error;
    const captured = prepared.snapshot;
    const selected = modelClient.resolve(captured.modelConfig.providerId, captured.modelConfig.modelId);
    const plan = planContext(captured, selected, dependencies.state);
    modelClient.assertMessageOrder(selected, plan.summary ? plan.summary.messages : plan.compiled.messages);
    const apiKey = await whileRunning(credentials.get(captured.modelConfig.credentialRef), signal);
    assertRunning(signal);
    if (!apiKey?.trim()) throw new AppError('CREDENTIAL_NOT_CONFIGURED');
    const context = await prepareContext(dependencies, execution, captured, selected, apiKey, plan);
    if (context.summary) {
      parentId = context.summary.id;
      summaryUsage = context.summary.metrics?.requests[0]?.usage ?? null;
    }
    stopReason = context.stopReason;
    assertRunning(signal);
    if (!stopReason) {
      const compiled = context.compiled;
      modelClient.assertMessageOrder(selected, compiled.messages);
      const result = await callModel(modelClient, selected, compiled.messages, {
        apiKey, signal, maxTokens: compiled.maxTokens,
        temperature: compiled.temperature, thinkingEnabled: compiled.thinkingEnabled,
      }, { events, fields: fields(), messageId: assistantEntryId });
      ({ snapshot, usage, attempted, metrics, finishReason, stopReason, receivedTerminal, publishedDelta } = result);
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

  try {
    if (hasPublicOutput(snapshot)) {
      const timestamp = Date.now();
      sessions.appendEntry(sessionId, {
        id: assistantEntryId, parentId, runId, type: 'message', role: 'assistant', timestamp,
        payload: { message: { ...copySnapshot(snapshot), timestamp } },
        state: null, extData: {}, metrics,
      });
    }
  } catch (error) {
    // Persistence failure takes precedence even if the model finished, failed or was cancelled.
    stopReason = error instanceof AppError && error.code === 'TIP_CONFLICT' ? 'tip_conflict'
      : error instanceof AppError && error.code === 'SESSION_NOT_FOUND' ? 'session_deleted' : 'message_persist_failed';
  }

  let savedMessageIds: string[] = [], tipEntryId: string | null = null;
  try {
    const session = sessions.get(sessionId);
    if (!session) stopReason = 'session_deleted';
    else {
      tipEntryId = session.tipEntryId;
      savedMessageIds = [userEntryId, assistantEntryId].filter(id => sessions.getEntry(sessionId, id) !== null);
      if (!savedMessageIds.includes(userEntryId) || (stopReason === undefined && !savedMessageIds.includes(assistantEntryId))) {
        stopReason = 'message_persist_failed';
      }
    }
  } catch {
    // Do not claim any unverified saved IDs if storage cannot report the settlement.
    savedMessageIds = [];
    tipEntryId = null;
    stopReason = 'message_persist_failed';
  }

  // Outcome belongs to the durable user entry, even if no assistant could be saved.
  try {
    sessions.setNarrativeOutcome(sessionId, userEntryId, stopReason === undefined
      ? { status: 'completed', finishedAt: Date.now() }
      : { status: 'stopped', stopReason, finishedAt: Date.now() });
  } catch {
    // Keep saved messages; a missing outcome remains unknown after restart.
    if (stopReason !== 'session_deleted') stopReason = 'message_persist_failed';
  }

  const total = addUsage(summaryUsage, attempted ? usage : zeroUsage());
  const usageEvent: NarrativeSettlement['usage'] = { event: 'run.usage', data: {
    ...fields(), usage: total === null ? null : {
      input_tokens: total.inputTokens, output_tokens: total.outputTokens, total_tokens: total.totalTokens,
      cache_read_tokens: total.cacheReadTokens, cache_write_tokens: total.cacheWriteTokens,
    },
  } };
  const data = { ...fields(), savedMessageIds, tipEntryId };
  return {
    usage: usageEvent,
    terminal: stopReason === undefined
      ? { event: 'run.completed', data }
      : { event: 'run.stopped', data: { ...data, stop_reason: stopReason } },
  };
}
