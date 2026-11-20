import { randomUUID } from 'node:crypto';
import { AppError } from '../../errors.js';
import type { ModelClient, ModelDelta, ModelEvent, ModelFinishReason, ModelInfo, ModelMessage, ModelOptions,
  ModelSnapshot, ModelStopReason, ModelUsage } from './client.js';

export const zeroUsage = (): ModelUsage => ({
  inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
});

export function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Model operation aborted', 'AbortError');
}

/** Cancellation is local even when a credential store or provider ignores its signal. */
export function raceAbort<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new DOMException('Model operation aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  return Promise.race([Promise.resolve(work), cancelled]).finally(() => signal.removeEventListener('abort', abort));
}

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
    if (fragment.id !== undefined) tool.id = fragment.id;
    if (fragment.function?.name !== undefined) tool.function.name = fragment.function.name;
    tool.function.arguments += fragment.function?.arguments ?? '';
  }
}

type CollectionObserver = {
  transformDelta?: (delta: Omit<ModelDelta, 'role'>) => Omit<ModelDelta, 'role'>;
  transformSnapshot?: (snapshot: ModelSnapshot) => ModelSnapshot;
  flush?: () => string;
  onDelta?: (delta: Omit<ModelDelta, 'role'>) => void;
};
export type ModelCallMetrics = {
  requests: { requestId: string; provider: string; modelId: string; usage: ModelUsage | null;
    durationMs: number; firstTextMs?: number }[];
};

/** SDK-independent collection and accounting; observers own any presentation or transport policy. */
export async function collectModel(modelClient: Pick<ModelClient, 'stream'>, selected: ModelInfo,
  messages: readonly ModelMessage[], options: ModelOptions, observer: CollectionObserver = {}) {
  const { signal } = options;
  let snapshot: ModelSnapshot = { role: 'assistant', content: '', reasoning_content: '', tool_calls: [] };
  let usage: ModelUsage | null = zeroUsage();
  let attempted = false, failed = false;
  let error: unknown;
  let requestId: string | undefined, startedAt: number | undefined, firstTextMs: number | undefined;
  let finishReason: ModelFinishReason | undefined, stopReason: ModelStopReason | undefined;
  let receivedTerminal = false, receivedDelta = false, observingAttempt = true;
  let iterator: AsyncIterator<ModelEvent> | undefined;
  const markFirstText = () => {
    if (firstTextMs === undefined && startedAt !== undefined) firstTextMs = performance.now() - startedAt;
  };
  try {
    assertNotAborted(signal);
    const invocationStartedAt = performance.now();
    iterator = modelClient.stream(selected, messages, options)[Symbol.asyncIterator]();
    while (true) {
      assertNotAborted(signal);
      const pending = Promise.resolve(iterator.next()).then(next => {
        // Record the attempt marker independently of the cancellation race, never late provider output.
        if (observingAttempt && !next.done && next.value.type === 'request_started') {
          if (attempted) throw new AppError('MODEL_OUTPUT_INVALID');
          attempted = true;
          requestId = randomUUID();
          startedAt = invocationStartedAt;
          usage = null;
        }
        return next;
      });
      const next = await raceAbort(pending, signal);
      assertNotAborted(signal);
      if (next.done) break;
      const event = next.value;
      if (event.type === 'request_started') continue;
      if (event.type === 'delta') {
        const copied = copyDelta(event.delta);
        const delta = observer.transformDelta ? observer.transformDelta(copied) : copied;
        appendDelta(snapshot, delta);
        if (delta.content) markFirstText();
        if (Object.keys(delta).length) {
          receivedDelta = true;
          observer.onDelta?.(copyDelta(delta));
        }
        continue;
      }
      receivedTerminal = true;
      const copied = copySnapshot(event.snapshot);
      snapshot = observer.transformSnapshot ? observer.transformSnapshot(copied) : copied;
      if (snapshot.content) markFirstText();
      if (attempted) usage = event.usage === null ? null : { ...event.usage };
      if (event.type === 'error') stopReason = event.stopReason;
      else finishReason = event.finishReason;
      break;
    }
    if (!receivedTerminal) stopReason = 'incomplete_output';
  } catch (caught) {
    failed = true;
    error = caught;
  } finally {
    observingAttempt = false;
    if (iterator?.return) {
      try { void Promise.resolve(iterator.return()).catch(() => {}); } catch { /* Best-effort cleanup. */ }
    }
  }
  if (!receivedTerminal) snapshot.content += observer.flush?.() ?? '';
  if (signal.aborted) stopReason = 'aborted';
  const metrics: ModelCallMetrics | null = attempted && requestId ? {
    requests: [{
      requestId, provider: selected.providerId, modelId: selected.modelId, usage,
      durationMs: performance.now() - startedAt!,
      ...(firstTextMs === undefined ? {} : { firstTextMs }),
    }],
  } : null;
  return { snapshot, usage, attempted, metrics, finishReason, stopReason, receivedTerminal, receivedDelta, failed, error };
}
