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
      dependencies.events.publish(sessionId, settlement.usage);
      dependencies.events.publish(sessionId, settlement.terminal);
    }).finally(() => {
      if (active.get(sessionId) === run) active.delete(sessionId);
    });
    return { runId, userEntryId, assistantEntryId, capabilities: { historyPolicy: 'full', postprocess: false } };
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

  return { submit, stop, shutdown };
}

export type NarrativeUsecases = ReturnType<typeof createNarrativeUsecases>;
