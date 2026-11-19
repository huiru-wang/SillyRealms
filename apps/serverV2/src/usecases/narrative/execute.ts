import { randomUUID } from 'node:crypto';
import { AppError, ERRORS, type ErrorCode } from '../../errors.js';
import type { PiEvent, PiUsage } from '../../infrastructure/pi/client.js';
import type { EntryMetrics } from '../../modules/sessions/service.js';
import { compileNarrativeContext } from './compile.js';
import type { NarrativeEvent, NarrativeTerminalEvent } from './events.js';
import type { NarrativeDependencies, NarrativeExecution } from './types.js';

function assertRunning(signal: AbortSignal): void {
  if (signal.aborted) throw new AppError('RUN_STOPPED');
}

/** Credential stores and injected iterators must not hold up local stop/shutdown. */
function whileRunning<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void Promise.resolve(work).catch(() => {});
    return Promise.reject(new AppError('RUN_STOPPED'));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new AppError('RUN_STOPPED'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(work).then(
      value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

/** The user is already durable. Only this invocation owns its assistant text and terminal event. */
export async function executeNarrative(dependencies: NarrativeDependencies, execution: NarrativeExecution): Promise<NarrativeTerminalEvent> {
  const { sessions, credentials, pi, events } = dependencies;
  const { sessionId, runId, userEntryId, assistantEntryId, prepared, signal } = execution;
  let body = '';
  let usage: PiUsage | null = null;
  let requestId: string | undefined;
  let modelId: string | undefined;
  let startedAt: number | undefined;
  let firstTextMs: number | undefined;
  let status: 'completed' | 'failed' | 'cancelled' = 'failed';
  let errorCode: ErrorCode | undefined;
  let iterator: AsyncIterator<PiEvent> | undefined;

  const publish = (event: NarrativeEvent) => events.publish(sessionId, event);
  const append = (text: string) => {
    if (!text) return;
    const offset = body.length;
    body += text;
    if (firstTextMs === undefined && startedAt !== undefined) firstTextMs = performance.now() - startedAt;
    publish({ event: 'message.delta', data: { runId, messageId: assistantEntryId, offset, text } });
  };

  publish({ event: 'run.started', data: { runId, userEntryId, assistantEntryId } });
  try {
    assertRunning(signal);
    if ('error' in prepared) throw prepared.error;
    const { snapshot } = prepared;
    const model = pi.resolve(snapshot.modelConfig.providerId, snapshot.modelConfig.modelId);
    const compiled = compileNarrativeContext(snapshot, model);
    pi.assertMessageOrder(model, compiled.messages);
    const apiKey = await whileRunning(credentials.get(snapshot.modelConfig.credentialRef), signal);
    assertRunning(signal);
    if (!apiKey?.trim()) throw new AppError('CREDENTIAL_NOT_CONFIGURED');

    requestId = randomUUID();
    modelId = snapshot.modelConfig.modelId;
    startedAt = performance.now();
    iterator = pi.stream(model, compiled.messages, {
      apiKey, signal, maxTokens: compiled.maxTokens,
      temperature: compiled.temperature, thinkingEnabled: compiled.thinkingEnabled,
    })[Symbol.asyncIterator]();
    let terminal = false;
    while (true) {
      assertRunning(signal);
      const next = await whileRunning(Promise.resolve(iterator.next()), signal);
      assertRunning(signal);
      if (next.done) break;
      const event = next.value;
      if (event.type === 'text_delta') {
        append(event.delta);
        continue;
      }
      terminal = true;
      usage = event.usage;
      // Some providers only report text in their final result.
      if (!body && event.text) append(event.text);
      if ((event.type === 'error' || event.stopReason !== 'stop') && event.text.startsWith(body)) {
        append(event.text.slice(body.length));
      }
      if (event.type === 'error') throw new AppError(event.errorCode);
      if (body !== event.text || !body.trim() || event.hasToolCalls) throw new AppError('MODEL_OUTPUT_INVALID');
      if (event.stopReason === 'aborted') throw new AppError('RUN_STOPPED');
      if (event.stopReason !== 'stop') throw new AppError('MODEL_OUTPUT_INCOMPLETE');
      assertRunning(signal);
      status = 'completed';
      break;
    }
    if (!terminal) throw new AppError('MODEL_OUTPUT_INCOMPLETE');
  } catch (error) {
    if (signal.aborted || (error instanceof AppError && error.code === 'RUN_STOPPED')) {
      status = 'cancelled';
      errorCode = 'RUN_STOPPED';
    } else {
      status = 'failed';
      errorCode = error instanceof AppError ? error.code : startedAt === undefined ? 'INTERNAL_ERROR' : 'PROVIDER_ERROR';
    }
  } finally {
    // A provider may ignore abort or never resolve return(); neither can block settlement.
    if (iterator?.return) {
      try { void Promise.resolve(iterator.return()).catch(() => {}); } catch { /* Best-effort cleanup. */ }
    }
  }

  if (signal.aborted) {
    status = 'cancelled';
    errorCode = 'RUN_STOPPED';
  }
  const durationMs = startedAt === undefined ? undefined : performance.now() - startedAt;
  const metrics: EntryMetrics | null = requestId && modelId ? {
    requests: [{ requestId, modelId, status, usage, durationMs, ...(firstTextMs === undefined ? {} : { firstTextMs }) }],
  } : null;
  let savedAssistantEntryId: string | null = null;
  try {
    if (body.trim()) {
      const timestamp = Date.now();
      sessions.appendEntry(sessionId, {
        id: assistantEntryId, parentId: userEntryId, runId, type: 'message', role: 'assistant', timestamp,
        payload: { message: { role: 'assistant', content: body, timestamp } },
        state: null, extData: {}, metrics,
      });
      savedAssistantEntryId = assistantEntryId;
    }
  } catch (error) {
    status = 'failed';
    errorCode = error instanceof AppError ? error.code : 'MESSAGE_PERSIST_FAILED';
  }

  let tipEntryId: string | null = null;
  try { tipEntryId = sessions.get(sessionId)?.tipEntryId ?? null; } catch { /* Never mask the actual terminal failure. */ }
  const data = { runId, userEntryId, assistantEntryId: savedAssistantEntryId, tipEntryId };
  if (status === 'completed' && savedAssistantEntryId !== null) {
    return { event: 'run.completed', data: { ...data, assistantEntryId: savedAssistantEntryId } };
  } else if (status === 'cancelled') {
    return { event: 'run.stopped', data };
  } else {
    const code = errorCode ?? 'MODEL_OUTPUT_INVALID';
    return { event: 'run.failed', data: { ...data, errorCode: code, errorMessage: ERRORS[code].message } };
  }
}
