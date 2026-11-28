import type { RunOptions, Session } from '../../modules/sessions/service.js';
import { randomUUID } from 'node:crypto';
import { createRunLogger } from '../../infrastructure/logging/run-logger.js';
import type { RunWritePermit } from '../../infrastructure/cache/index.js';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { startNarrative } from './start.js';
import { prepareRegeneration, regenerateSchema } from './regenerate.js';
import type { AcceptedNarrative, ActiveNarrative, NarrativeDependencies, SubmitInput, RegenerateInput, ReadyNarrative } from './types.js';

export type { AcceptedNarrative, NarrativeDependencies, SubmitInput, RegenerateInput } from './types.js';
const identifier = z.string().min(1).refine(value => value === value.trim());
const submitSchema = z.object({
  sessionId: identifier,
  input: z.object({ text: z.string().refine(value => value.trim().length > 0, '输入不能为空') }).strict(),
  expectedTipEntryId: identifier.nullable(),
}).strict();

/** One lock spans admission, all generation stages and settlement. */
export function createNarrativeUsecases(dependencies: NarrativeDependencies) {
  const active = new Map<string, ActiveNarrative>();
  let shuttingDown = false;
  let storageFailed = false;
  let closing: Promise<void> | undefined;
  const check = (sessionId: string, expectedTipEntryId: string | null) => {
    if (storageFailed) throw new AppError('STORAGE_UNAVAILABLE');
    if (shuttingDown) throw new AppError('SERVER_SHUTTING_DOWN');
    const session = dependencies.sessions.require(sessionId);
    if (active.has(sessionId)) throw new AppError('RUN_ALREADY_ACTIVE');
    if (session.tipEntryId !== expectedTipEntryId) throw new AppError('TIP_CONFLICT');
    return session;
  };
  const begin = (session: Session, runId: string,
    prepare: (permit: RunWritePermit, assistantEntryId: string) => ReadyNarrative): AcceptedNarrative => {
    const assistantEntryId = randomUUID(), sessionId = session.id;
    const permit = dependencies.cache.acquireRun({ sessionId, worldId: session.worldId, runId });
    const run: ActiveNarrative = { runId, assistantEntryId, controller: new AbortController(),
      completion: Promise.resolve(), log: createRunLogger({ runId, sessionId }, dependencies.logSink) };
    active.set(sessionId, run);
    const release = () => {
      if (active.get(sessionId) === run) active.delete(sessionId);
      dependencies.cache.releaseRun(permit);
    };
    try {
      const ready = prepare(permit, assistantEntryId);
      startNarrative({ ...dependencies, onStorageFailure(error) {
        storageFailed = true;
        dependencies.onStorageFailure?.(error);
      } }, session, run, ready, permit, release);
      return { runId, assistantEntryId, userEntryId: ready.userMessage.id, userMessage: { ...ready.userMessage },
        tipEntryId: ready.tipEntryId, deletedMessageIds: [...ready.deletedMessageIds] };
    } catch (error) { release(); throw error; }
  };
  const submit = (input: SubmitInput): AcceptedNarrative => {
    const value = submitSchema.parse(input), { sessionId, expectedTipEntryId } = value;
    const session = check(sessionId, expectedTipEntryId), runId = randomUUID();
    return begin(session, runId, (permit, assistantId) => {
      const timestamp = Date.now();
      const user = dependencies.sessions.beginRun(sessionId, runId, assistantId, {
        id: randomUUID(), parentId: expectedTipEntryId, timestamp,
        payload: { message: { role: 'user', content: value.input.text, timestamp } },
      }, permit);
      return { userMessage: { id: user.id, status: 'complete', role: 'user', content: value.input.text, timestamp: user.timestamp },
        tipEntryId: user.id, deletedMessageIds: [], notifications: [] };
    });
  };
  const regenerate = (input: RegenerateInput): AcceptedNarrative => {
    const value = regenerateSchema.parse(input), session = check(value.sessionId, value.expectedTipEntryId);
    return begin(session, value.runId, (permit, assistantEntryId) => prepareRegeneration(dependencies, value, permit, assistantEntryId));
  };

  const stop = (sessionId: string, runId: string, assistantEntryId: string): { runId: string; assistantEntryId: string; stopping: true } => {
    dependencies.sessions.require(identifier.parse(sessionId));
    const run = active.get(sessionId);
    if (!run || run.runId !== identifier.parse(runId) || run.assistantEntryId !== identifier.parse(assistantEntryId)) throw new AppError('RUN_NOT_FOUND');
    if (shuttingDown && run.controller.signal.reason === 'server_shutdown') throw new AppError('SERVER_SHUTTING_DOWN');
    if (!run.controller.signal.aborted) {
      dependencies.sessions.markStopping(sessionId, runId, assistantEntryId);
      run.log('run.stop_requested', { reason: 'cancelled' });
      run.controller.abort('cancelled');
    }
    return { runId, assistantEntryId, stopping: true };
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

  const list = (sessionId: string, options: RunOptions = {}) => dependencies.sessions.listRuns(sessionId, options);
  const get = (sessionId: string, runId: string) => dependencies.sessions.getRun(sessionId, runId);
  const usage = (sessionId: string) => dependencies.sessions.recordedUsage(sessionId);

  return { submit, regenerate, stop, shutdown, list, get, usage };
}

export type NarrativeUsecases = ReturnType<typeof createNarrativeUsecases>;
