import type { EntryRun, EntryRunListOptions } from '../../modules/sessions/service.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { captureNarrativeContext } from './context.js';
import { executeNarrative } from './execute.js';
import type { SavedUserMessage } from './events.js';
import type { AcceptedNarrative, NarrativeDependencies, PreparedNarrative, SubmitInput } from './types.js';

export type { AcceptedNarrative, NarrativeDependencies, SubmitInput } from './types.js';

const identifier = z.string().min(1).refine(value => value === value.trim());
const submitSchema = z.object({
  sessionId: identifier,
  input: z.object({ text: z.string().refine(value => value.trim().length > 0, '输入不能为空') }).strict(),
  expectedTipEntryId: identifier.nullable(),
}).strict();
type ActiveRun = { runId: string; controller: AbortController; completion: Promise<void> };

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
    const run: ActiveRun = { runId, controller: new AbortController(), completion: Promise.resolve() };
    active.set(sessionId, run);
    let userMessage: SavedUserMessage;
    try {
      const timestamp = Date.now();
      const saved = dependencies.sessions.appendEntry(sessionId, {
        id: userEntryId, parentId: expectedTipEntryId, runId, type: 'message', role: 'user', timestamp,
        payload: { message: { role: 'user', content: value.input.text, timestamp } },
        state: null, extData: {}, metrics: null,
      });
      userMessage = { id: saved.id, role: 'user', content: value.input.text, timestamp: saved.timestamp };
    } catch (error) {
      active.delete(sessionId);
      throw error;
    }

    let prepared: PreparedNarrative;
    let provider: string | null = null, model: string | null = null;
    try {
      const configured = dependencies.models.get(session.apiModelConfigId);
      provider = configured?.providerId ?? null;
      model = configured?.modelId ?? null;
      prepared = { snapshot: captureNarrativeContext(dependencies, {
        sessionId, inputText: value.input.text, userEntryId, previousTipEntryId: expectedTipEntryId,
      }) };
    } catch (error) {
      prepared = { error };
    }
    run.completion = Promise.resolve().then(() => executeNarrative(dependencies, {
      sessionId, runId, userEntryId, assistantEntryId, userMessage, provider, model, prepared, signal: run.controller.signal,
    })).then(settlement => {
      // Settlement is complete: observers may stop or submit a new turn without finding a stale active run.
      if (active.get(sessionId) === run) active.delete(sessionId);
      for (const event of [...settlement.notifications, settlement.usage, settlement.terminal]) {
        try { dependencies.events.publish(sessionId, event); }
        catch { /* Notification delivery cannot change a committed outcome or skip later events. */ }
      }
    }).finally(() => {
      if (active.get(sessionId) === run) active.delete(sessionId);
    });
    return { runId, userEntryId, assistantEntryId };
  };

  const stop = (sessionId: string, runId: string): { runId: string; stopping: true } => {
    dependencies.sessions.require(identifier.parse(sessionId));
    const run = active.get(sessionId);
    if (!run || run.runId !== identifier.parse(runId)) throw new AppError('RUN_NOT_FOUND');
    run.controller.abort('cancelled');
    return { runId, stopping: true };
  };

  const shutdown = (): Promise<void> => {
    if (closing) return closing;
    shuttingDown = true;
    for (const run of active.values()) run.controller.abort('server_shutdown');
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
  const get = (sessionId: string, runId: string) => {
    const entries = dependencies.sessions.listRunEntries(sessionId, runId);
    if (!entries.length) throw new AppError('RUN_NOT_FOUND');
    return projectRun(sessionId, { runId, firstSeq: entries[0]!.seq, lastSeq: entries.at(-1)!.seq, entries });
  };
  const usage = (sessionId: string) => dependencies.sessions.recordedUsage(sessionId);

  return { submit, stop, shutdown, list, get, usage };
}

export type NarrativeUsecases = ReturnType<typeof createNarrativeUsecases>;
