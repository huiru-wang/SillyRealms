import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { captureNarrativeContext } from './context.js';
import { executeNarrative } from './execute.js';
import type { AcceptedNarrative, NarrativeDependencies, PreparedNarrative, SubmitInput } from './types.js';

export type { AcceptedNarrative, NarrativeDependencies, SubmitInput } from './types.js';

const identifier = z.string().min(1).refine(value => value === value.trim());
const submitSchema = z.object({
  sessionId: identifier,
  input: z.object({ text: z.string().refine(value => value.trim().length > 0, '输入不能为空') }).strict(),
  expectedTipEntryId: identifier.nullable(),
}).strict();
type ActiveRun = { runId: string; controller: AbortController; completion: Promise<void> };

/** A single-process admission gate, not a persistent task store or execution engine. */
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
    try {
      const timestamp = Date.now();
      dependencies.sessions.appendEntry(sessionId, {
        id: userEntryId, parentId: expectedTipEntryId, runId, type: 'message', role: 'user', timestamp,
        payload: { message: { role: 'user', content: value.input.text, timestamp } },
        state: null, extData: {}, metrics: null,
      });
    } catch (error) {
      active.delete(sessionId);
      throw error;
    }

    let prepared: PreparedNarrative;
    try {
      prepared = { snapshot: captureNarrativeContext(dependencies, {
        sessionId, inputText: value.input.text, userEntryId, previousTipEntryId: expectedTipEntryId,
      }) };
    } catch (error) {
      prepared = { error };
    }
    run.completion = Promise.resolve().then(() => executeNarrative(dependencies, {
      sessionId, runId, userEntryId, assistantEntryId, prepared, signal: run.controller.signal,
    })).then(event => {
      // Release admission before observers receive the terminal result and submit their next turn.
      if (active.get(sessionId) === run) active.delete(sessionId);
      dependencies.events.publish(sessionId, event);
    }).finally(() => {
      if (active.get(sessionId) === run) active.delete(sessionId);
    });
    return { runId, userEntryId, assistantEntryId, capabilities: { historyPolicy: 'full', postprocess: false } };
  };

  const stop = (sessionId: string, runId: string): { runId: string; stopping: true } => {
    dependencies.sessions.require(identifier.parse(sessionId));
    const run = active.get(sessionId);
    if (!run || run.runId !== identifier.parse(runId)) throw new AppError('RUN_NOT_FOUND');
    run.controller.abort();
    return { runId, stopping: true };
  };

  const shutdown = (): Promise<void> => {
    if (closing) return closing;
    shuttingDown = true;
    for (const run of active.values()) run.controller.abort();
    closing = Promise.all([...active.values()].map(run => run.completion)).then(() => {});
    return closing;
  };

  return { submit, stop, shutdown };
}

export type NarrativeUsecases = ReturnType<typeof createNarrativeUsecases>;
