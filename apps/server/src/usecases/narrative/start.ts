import { AppError } from '../../errors.js';
import { prepareContext } from '../context/index.js';
import type { PreparedContext, SummaryModelRequest } from '../context/index.js';
import { collectModel } from '../../infrastructure/model/collect.js';
import type { RunWritePermit } from '../../infrastructure/cache/index.js';
import type { Session } from '../../modules/sessions/service.js';
import { assertRunning, whileRunning } from './model-call.js';
import { executeNarrative } from './execute.js';
import type { ActiveNarrative, NarrativeDependencies, ReadyNarrative } from './types.js';

/** Both send and regeneration enter here after their user and tip are durable. */
export function startNarrative(dependencies: NarrativeDependencies, session: Session, run: ActiveNarrative,
  ready: ReadyNarrative, writePermit: RunWritePermit, release: () => void): void {
  const sessionId = session.id, { runId, assistantEntryId, log } = run;
  const { userMessage } = ready, userEntryId = userMessage.id;
  let provider: string | null = null, model: string | null = null;
  try {
    const configured = dependencies.models.get(session.apiModelConfigId);
    provider = configured?.providerId ?? null;
    model = configured?.modelId ?? null;
  } catch { /* The context entry reports the captured domain failure during settlement. */ }
  let apiKeyPromise: Promise<string> | undefined;
  const getApiKey = (credentialRef: SummaryModelRequest['credentialRef']): Promise<string> => apiKeyPromise ??= (async () => {
    assertRunning(run.controller.signal);
    const key = await whileRunning(dependencies.credentials.get(credentialRef), run.controller.signal);
    assertRunning(run.controller.signal);
    if (!key?.trim()) throw new AppError('CREDENTIAL_NOT_CONFIGURED');
    return key;
  })();
  const summarize = async (request: SummaryModelRequest) => {
    const apiKey = await getApiKey(request.credentialRef);
    assertRunning(request.signal);
    request.onStarted();
    const result = await collectModel(dependencies.modelClient, request.model, request.messages, {
      apiKey, signal: request.signal, maxTokens: request.maxTokens,
      ...request.modelParameters,
      onDiagnostic(event) {
        log('model.' + event.type, { purpose: 'summary', provider: request.model.providerId,
          model: request.model.modelId, source: event.source, raw: event.data });
      },
    });
    if (result.failed || result.stopReason || !result.attempted || result.finishReason !== 'stop' ||
      !result.snapshot.content.trim() || result.snapshot.tool_calls.length) return { ok: false as const };
    return { ok: true as const, text: result.snapshot.content, metrics: result.metrics };
  };
  // The accepted run exists now; synchronous stop/shutdown logs must follow its creation.
  const timestamp = Date.now();
  log('run.created', { runId, assistantEntryId, sessionId, provider, model, timestamp,
    messages: [{ ...userMessage }] }, timestamp);
  // Queue run.created first, then synchronously capture through the sole context entry below.
  run.completion = Promise.resolve().then(() => {
    for (const event of ready.notifications) {
      log(event.event, event.data);
      try { dependencies.events.publish(sessionId, event); } catch { /* Committed changes remain committed. */ }
    }
    return executeNarrative(dependencies, {
      sessionId, runId, userEntryId, assistantEntryId, userMessage, tipEntryId: ready.tipEntryId,
      deletedMessageIds: ready.deletedMessageIds, provider, model, prepared, getApiKey,
      signal: run.controller.signal, log, writePermit,
    });
  }).then(settlement => {
    // Settlement is complete: observers may stop or submit a new turn without finding a stale active run.
    release();
    for (const event of [...settlement.notifications, settlement.usage, settlement.terminal]) {
      log(event.event, event.data, 'timestamp' in event.data ? event.data.timestamp : undefined);
      try { dependencies.events.publish(sessionId, event); }
      catch { /* Notification delivery cannot change a committed outcome or skip later events. */ }
    }
  }).finally(() => {
    release();
  });
  const prepared: Promise<PreparedContext> = prepareContext({
    settings: dependencies.settings, sessions: dependencies.sessions, worlds: dependencies.worlds, presets: dependencies.presets,
    models: dependencies.models, state: dependencies.state, modelClient: dependencies.modelClient, summarize,
  }, {
    sessionId, writePermit, signal: run.controller.signal,
    onProgress(progress) {
      const fields = { sessionId, runId, assistantEntryId, provider, model, timestamp: Date.now() };
      if (progress.type === 'summary_started') {
        log('run.summarizing', fields, fields.timestamp);
        dependencies.events.publish(sessionId, { event: 'run.summarizing', data: fields });
      } else {
        const data = { ...fields, entryId: progress.entryId };
        log('run.summarized', data, fields.timestamp);
        dependencies.events.publish(sessionId, { event: 'run.summarized', data });
      }
    },
  });
}
