import { randomUUID } from 'node:crypto';
import { AppError } from '../../errors.js';
import type { ModelClient, ModelDelta, ModelEvent, ModelFinishReason, ModelInfo, ModelMessage, ModelOptions,
  ModelSnapshot, ModelStopReason, ModelUsage } from '../../infrastructure/model/client.js';
import type { EventHub } from '../../infrastructure/events/event-hub.js';
import type { EntryMetrics } from '../../modules/sessions/service.js';
import type { NarrativeStopReason, RunEventFields } from './events.js';

export const zeroUsage = (): ModelUsage => ({
  inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
});

export function assertRunning(signal: AbortSignal): void {
  if (signal.aborted) throw new AppError('RUN_STOPPED');
}

/** A slow credential store or iterator cannot hold local cancellation or shutdown open. */
export function whileRunning<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new AppError('RUN_STOPPED'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  return Promise.race([Promise.resolve(work), cancelled]).finally(() => signal.removeEventListener('abort', abort));
}

export function cancellationReason(signal: AbortSignal): NarrativeStopReason {
  return signal.reason === 'server_shutdown' ? 'server_shutdown' : 'cancelled';
}

export function failureReason(error: unknown, attempted: boolean): NarrativeStopReason {
  if (!(error instanceof AppError)) return attempted ? 'provider_error' : 'internal_error';
  switch (error.code) {
    case 'MODEL_NOT_FOUND': return 'model_not_found';
    case 'MODEL_CAPABILITY_UNSUPPORTED': return 'model_capability_unsupported';
    case 'CREDENTIAL_NOT_CONFIGURED': return 'credential_not_configured';
    case 'CREDENTIAL_STORE_ERROR': return 'credential_unavailable';
    case 'PROVIDER_CONTEXT_WINDOW_EXCEEDED': return 'provider_context_window_exceeded';
    case 'PROVIDER_ERROR': return 'provider_error';
    case 'RUN_STOPPED': return 'provider_aborted';
    case 'MODEL_OUTPUT_INCOMPLETE': return 'output_incomplete';
    case 'MODEL_OUTPUT_INVALID': return 'model_output_invalid';
    case 'SUMMARY_CAPACITY_EXCEEDED': return 'summary_capacity_exceeded';
    case 'CONTEXT_BUDGET_EXCEEDED': return 'context_budget_exceeded';
    case 'TIP_CONFLICT': return 'tip_conflict';
    case 'SESSION_NOT_FOUND': return 'session_deleted';
    case 'MESSAGE_PERSIST_FAILED': return 'message_persist_failed';
    case 'INVALID_NARRATIVE_HISTORY':
    case 'INVALID_NARRATIVE_TEMPLATE':
    case 'INVALID_NARRATIVE_STATE':
    case 'INVALID_MODEL_BUDGET':
    case 'INVALID_PARENT_CHAIN':
    case 'MODEL_CONFIG_NOT_FOUND':
    case 'PRESET_NOT_FOUND':
    case 'WORLD_NOT_FOUND': return 'invalid_context';
    default: return 'internal_error';
  }
}

function modelFailureReason(reason: ModelStopReason): NarrativeStopReason {
  switch (reason) {
    case 'aborted': return 'provider_aborted';
    case 'provider_error': return 'provider_error';
    case 'context_window_exceeded': return 'provider_context_window_exceeded';
    case 'invalid_output': return 'model_output_invalid';
    case 'incomplete_output': return 'output_incomplete';
  }
}

/** Copy only the application-owned public fields; never share a provider's mutable objects. */
export function copySnapshot(snapshot: ModelSnapshot): ModelSnapshot {
  return {
    role: 'assistant', content: snapshot.content, reasoning_content: snapshot.reasoning_content,
    tool_calls: snapshot.tool_calls.map(tool => ({
      index: tool.index, id: tool.id, type: 'function',
      function: { name: tool.function.name, arguments: tool.function.arguments },
    })),
  };
}

function copyDelta(delta: ModelDelta): Omit<ModelDelta, 'role'> {
  return {
    ...(delta.content === undefined ? {} : { content: delta.content }),
    ...(delta.reasoning_content === undefined ? {} : { reasoning_content: delta.reasoning_content }),
    ...(delta.tool_calls === undefined ? {} : { tool_calls: delta.tool_calls.map(tool => ({
      index: tool.index,
      ...(tool.id === undefined ? {} : { id: tool.id }),
      ...(tool.type === undefined ? {} : { type: tool.type }),
      ...(tool.function === undefined ? {} : { function: {
        ...(tool.function.name === undefined ? {} : { name: tool.function.name }),
        ...(tool.function.arguments === undefined ? {} : { arguments: tool.function.arguments }),
      } }),
    })) }),
  };
}

function appendDelta(snapshot: ModelSnapshot, delta: ModelDelta): void {
  snapshot.content += delta.content ?? '';
  snapshot.reasoning_content += delta.reasoning_content ?? '';
  for (const fragment of delta.tool_calls ?? []) {
    let tool = snapshot.tool_calls.find(item => item.index === fragment.index);
    if (!tool) {
      tool = { index: fragment.index, id: '', type: 'function', function: { name: '', arguments: '' } };
      snapshot.tool_calls.push(tool);
      snapshot.tool_calls.sort((left, right) => left.index - right.index);
    }
    // Identity and function name are replacements; arguments are streamed string fragments.
    if (fragment.id !== undefined) tool.id = fragment.id;
    if (fragment.function?.name !== undefined) tool.function.name = fragment.function.name;
    tool.function.arguments += fragment.function?.arguments ?? '';
  }
}

export function hasPublicOutput(snapshot: ModelSnapshot): boolean {
  return Boolean(snapshot.content.trim() || snapshot.reasoning_content.trim() || snapshot.tool_calls.length);
}

/** Shared cancellable invocation; only narrative calls opt into EventHub text publication. */
export async function callModel(modelClient: Pick<ModelClient, 'stream'>, selected: ModelInfo,
  messages: readonly ModelMessage[], options: ModelOptions,
  publication?: { events: EventHub; fields: RunEventFields; messageId: string }) {
  const { signal } = options;
  let snapshot: ModelSnapshot = { role: 'assistant', content: '', reasoning_content: '', tool_calls: [] };
  let usage: ModelUsage | null = zeroUsage();
  let attempted = false;
  let requestId: string | undefined;
  let startedAt: number | undefined;
  let firstTextMs: number | undefined;
  let finishReason: ModelFinishReason | undefined;
  let stopReason: NarrativeStopReason | undefined;
  let receivedTerminal = false, publishedDelta = false, observingAttempt = true;
  let iterator: AsyncIterator<ModelEvent> | undefined;

  const markFirstText = () => {
    if (firstTextMs === undefined && startedAt !== undefined) firstTextMs = performance.now() - startedAt;
  };

  try {
    assertRunning(signal);
    const invocationStartedAt = performance.now();
    iterator = modelClient.stream(selected, messages, options)[Symbol.asyncIterator]();
    while (true) {
      assertRunning(signal);
      const pending = Promise.resolve(iterator.next()).then(next => {
        // An async generator queues this marker even if the SDK synchronously triggered abort.
        // Observe only the invocation fact independently of the cancellation race, never its output.
        if (observingAttempt && !next.done && next.value.type === 'request_started') {
          if (attempted) throw new AppError('MODEL_OUTPUT_INVALID');
          attempted = true;
          requestId = randomUUID();
          startedAt = invocationStartedAt;
          usage = null;
        }
        return next;
      });
      const next = await whileRunning(pending, signal);
      // Cancellation freezes public content and usage before any late provider result is read.
      assertRunning(signal);
      if (next.done) break;
      const event = next.value;
      if (event.type === 'request_started') continue;
      if (event.type === 'delta') {
        const delta = copyDelta(event.delta);
        appendDelta(snapshot, delta);
        if (delta.content) markFirstText();
        if (Object.keys(delta).length) {
          publishedDelta = true;
          if (publication) publication.events.publish(publication.fields.sessionId, { event: 'run.delta', data: {
            ...publication.fields, timestamp: Date.now(), messageId: publication.messageId,
            messages: [{ role: 'assistant', delta: copyDelta(delta) }],
          } });
        }
        continue;
      }
      receivedTerminal = true;
      snapshot = copySnapshot(event.snapshot);
      if (snapshot.content) markFirstText();
      if (attempted) usage = event.usage === null ? null : { ...event.usage };
      if (event.type === 'error') {
        stopReason = modelFailureReason(event.stopReason);
      } else {
        finishReason = event.finishReason;
        if (snapshot.tool_calls.length || finishReason === 'tool_calls') stopReason = 'tool_execution_unsupported';
        else if (finishReason !== 'stop') stopReason = 'output_incomplete';
        else if (!snapshot.content.trim()) stopReason = 'model_output_invalid';
      }
      break;
    }
    if (!receivedTerminal) stopReason = 'output_incomplete';
  } catch (error) {
    stopReason = signal.aborted ? cancellationReason(signal) : failureReason(error, attempted);
  } finally {
    observingAttempt = false;
    // A provider may ignore abort or never resolve return(); neither delays local settlement.
    if (iterator?.return) {
      try { void Promise.resolve(iterator.return()).catch(() => {}); } catch { /* Best-effort cleanup. */ }
    }
  }

  if (signal.aborted) stopReason = cancellationReason(signal);
  const metrics: EntryMetrics | null = attempted && requestId ? {
    requests: [{
      requestId, provider: selected.providerId, modelId: selected.modelId, usage,
      durationMs: performance.now() - startedAt!,
      ...(firstTextMs === undefined ? {} : { firstTextMs }),
    }],
  } : null;
  return { snapshot, usage, attempted, metrics, finishReason, stopReason, receivedTerminal, publishedDelta };
}
