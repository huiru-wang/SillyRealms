import type { EntryRun, EntryRunListOptions } from '../../modules/sessions/service.js';
import { randomUUID } from 'node:crypto';
import { createRunLogger, type RunLogger } from '../../infrastructure/logging/run-logger.js';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { prepareContext } from '../context/index.js';
import type { PreparedContext, SummaryModelRequest } from '../context/index.js';
import { collectModel } from '../../infrastructure/model/collect.js';
import { assertRunning, whileRunning } from './model-call.js';
import { executeNarrative } from './execute.js';
import type { SavedUserMessage } from './events.js';
import type { AcceptedNarrative, NarrativeDependencies, SubmitInput } from './types.js';

export type { AcceptedNarrative, NarrativeDependencies, SubmitInput } from './types.js';

const identifier = z.string().min(1).refine(value => value === value.trim());
const submitSchema = z.object({
  sessionId: identifier,
  input: z.object({ text: z.string().refine(value => value.trim().length > 0, '输入不能为空') }).strict(),
  expectedTipEntryId: identifier.nullable(),
}).strict();
type ActiveRun = { runId: string; controller: AbortController; completion: Promise<void>; log: RunLogger };

/** Session execution lock spans user persistence, optional summary, narrative and settlement. */
export function createNarrativeUsecases(dependencies: NarrativeDependencies) {
  const active = new Map<string, ActiveRun>();
  let shuttingDown = false;
  let closing: Promise<void> | undefined;

  const submit = (input: SubmitInput): AcceptedNarrative => {
    if (shuttingDown) throw new AppError('SERVER_SHUTTING_DOWN');
    const value = submitSchema.parse(input);
    const { sessionId, expectedTipEntryId } = value;
    const session = dependencies.sessions.require(sessionId);
    if (active.has(sessionId)) throw new AppError('RUN_ALREADY_ACTIVE');
    if (session.tipEntryId !== expectedTipEntryId) throw new AppError('TIP_CONFLICT');

    const runId = randomUUID(), userEntryId = randomUUID(), assistantEntryId = randomUUID();
    const log = createRunLogger({ runId, sessionId }, dependencies.logSink);
    const writePermit = dependencies.cache.acquireRun({ sessionId, worldId: session.worldId, runId });
    const run: ActiveRun = { runId, controller: new AbortController(), completion: Promise.resolve(), log };
    active.set(sessionId, run);
    let userMessage: SavedUserMessage;
    try {
      const timestamp = Date.now();
      const saved = dependencies.sessions.appendEntry(sessionId, {
        id: userEntryId, parentId: expectedTipEntryId, runId, type: 'message', role: 'user', timestamp,
        payload: { message: { role: 'user', content: value.input.text, timestamp } },
        state: null, extData: {}, metrics: null,
      }, writePermit);
      userMessage = { id: saved.id, role: 'user', content: value.input.text, timestamp: saved.timestamp };
    } catch (error) {
      active.delete(sessionId);
      dependencies.cache.releaseRun(writePermit);
      throw error;
    }

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
    log('run.created', { runId, sessionId, provider, model, timestamp: userMessage.timestamp,
      messages: [{ ...userMessage }] }, userMessage.timestamp);
    // Queue run.created first, then synchronously capture through the sole context entry below.
    run.completion = Promise.resolve().then(() => executeNarrative(dependencies, {
      sessionId, runId, userEntryId, assistantEntryId, userMessage, provider, model, prepared, getApiKey, signal: run.controller.signal, log, writePermit,
    })).then(settlement => {
      // Settlement is complete: observers may stop or submit a new turn without finding a stale active run.
      if (active.get(sessionId) === run) active.delete(sessionId);
      dependencies.cache.releaseRun(writePermit);
      for (const event of [...settlement.notifications, settlement.usage, settlement.terminal]) {
        log(event.event, event.data, 'timestamp' in event.data ? event.data.timestamp : undefined);
        try { dependencies.events.publish(sessionId, event); }
        catch { /* Notification delivery cannot change a committed outcome or skip later events. */ }
      }
    }).finally(() => {
      if (active.get(sessionId) === run) active.delete(sessionId);
      dependencies.cache.releaseRun(writePermit);
    });
    const prepared: Promise<PreparedContext> = prepareContext({
      sessions: dependencies.sessions, worlds: dependencies.worlds, presets: dependencies.presets,
      models: dependencies.models, state: dependencies.state, modelClient: dependencies.modelClient, summarize,
    }, {
      sessionId, writePermit, signal: run.controller.signal,
      onProgress(progress) {
        const fields = { sessionId, runId, provider, model, timestamp: Date.now() };
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
    return { runId, userEntryId, assistantEntryId, userMessage: { ...userMessage } };
  };

  const stop = (sessionId: string, runId: string): { runId: string; stopping: true } => {
    dependencies.sessions.require(identifier.parse(sessionId));
    const run = active.get(sessionId);
    if (!run || run.runId !== identifier.parse(runId)) throw new AppError('RUN_NOT_FOUND');
    if (!run.controller.signal.aborted) {
      run.log('run.stop_requested', { reason: 'cancelled' });
      run.controller.abort('cancelled');
    }
    return { runId, stopping: true };
  };

  const shutdown = (): Promise<void> => {
    if (closing) return closing;
    shuttingDown = true;
    for (const run of active.values()) {
      if (!run.controller.signal.aborted) {
        run.log('run.stop_requested', { reason: 'server_shutdown' });
        run.controller.abort('server_shutdown');
      }
    }
    closing = Promise.all([...active.values()].map(run => run.completion)).then(() => {});
    return closing;
  };

  const projectRun = (sessionId: string, item: EntryRun) => {
    const current = active.get(sessionId);
    const first = item.entries[0];
    const outcome = first ? dependencies.sessions.getNarrativeOutcome(first) : null;
    const state = outcome ?? (current?.runId === item.runId
      ? { status: current.controller.signal.aborted ? 'stopping' as const : 'running' as const }
      : { status: 'unknown' as const });
    return { ...item, ...state };
  };
  const list = (sessionId: string, options: EntryRunListOptions = {}) => {
    const page = dependencies.sessions.listEntryRuns(sessionId, options);
    return { ...page, items: page.items.map(item => projectRun(sessionId, item)),
      activeRunId: active.get(sessionId)?.runId ?? null };
  };
  const usage = (sessionId: string) => dependencies.sessions.recordedUsage(sessionId);

  return { submit, stop, shutdown, list, usage };
}

export type NarrativeUsecases = ReturnType<typeof createNarrativeUsecases>;
