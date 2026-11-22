import type { EntryRun, EntryRunListOptions, Session } from '../../modules/sessions/service.js';
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
  let closing: Promise<void> | undefined;
  const check = (sessionId: string, expectedTipEntryId: string | null) => {
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
      startNarrative(dependencies, session, run, ready, permit, release);
      return { runId, assistantEntryId, userEntryId: ready.userMessage.id, userMessage: { ...ready.userMessage },
        tipEntryId: ready.tipEntryId, deletedMessageIds: [...ready.deletedMessageIds] };
    } catch (error) { release(); throw error; }
  };
  const submit = (input: SubmitInput): AcceptedNarrative => {
    const value = submitSchema.parse(input), { sessionId, expectedTipEntryId } = value;
    const session = check(sessionId, expectedTipEntryId), runId = randomUUID();
    return begin(session, runId, permit => {
      const timestamp = Date.now();
      const user = dependencies.sessions.appendEntry(sessionId, {
        id: randomUUID(), parentId: expectedTipEntryId, runId, type: 'message', role: 'user', timestamp,
        payload: { message: { role: 'user', content: value.input.text, timestamp } },
        state: null, extData: {}, metrics: null,
      }, permit);
      return { userMessage: { id: user.id, role: 'user', content: value.input.text, timestamp: user.timestamp },
        tipEntryId: user.id, deletedMessageIds: [], notifications: [] };
    });
  };
  const regenerate = (input: RegenerateInput): AcceptedNarrative => {
    const value = regenerateSchema.parse(input), session = check(value.sessionId, value.expectedTipEntryId);
    const user = dependencies.sessions.getEntry(value.sessionId, value.userEntryId);
    if (!user || user.role !== 'user') throw new AppError('INVALID_REGENERATION_TARGET');
    return begin(session, user.runId, (permit, assistantEntryId) => prepareRegeneration(dependencies, value, permit, assistantEntryId));
  };

  const stop = (sessionId: string, runId: string, assistantEntryId: string): { runId: string; assistantEntryId: string; stopping: true } => {
    dependencies.sessions.require(identifier.parse(sessionId));
    const run = active.get(sessionId);
    if (!run || run.runId !== identifier.parse(runId) || run.assistantEntryId !== identifier.parse(assistantEntryId)) throw new AppError('RUN_NOT_FOUND');
    if (!run.controller.signal.aborted) {
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

  const projectRun = (sessionId: string, item: EntryRun) => {
    const current = active.get(sessionId);
    const first = item.entries[0];
    const outcome = first ? dependencies.sessions.getNarrativeOutcome(first) : null;
    const state = current?.runId === item.runId
      ? { status: current.controller.signal.aborted ? 'stopping' as const : 'running' as const,
          assistantEntryId: current.assistantEntryId }
      : outcome ?? { status: 'unknown' as const };
    return { ...item, ...state };

  };
  const list = (sessionId: string, options: EntryRunListOptions = {}) => {
    const page = dependencies.sessions.listEntryRuns(sessionId, options);
    return { ...page, items: page.items.map(item => projectRun(sessionId, item)),
      activeRunId: active.get(sessionId)?.runId ?? null };
  };
  const usage = (sessionId: string) => dependencies.sessions.recordedUsage(sessionId);

  return { submit, regenerate, stop, shutdown, list, usage };
}

export type NarrativeUsecases = ReturnType<typeof createNarrativeUsecases>;
