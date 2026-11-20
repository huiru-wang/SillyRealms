import type { RuntimeCache } from '../infrastructure/cache/index.js';
import { AppError, ERRORS } from '../errors.js';
import type { EventHub } from '../infrastructure/events/event-hub.js';
import type { TransactionRunner } from '../infrastructure/database/transaction.js';
import type { SessionService } from '../modules/sessions/service.js';
import {
  StateValidationError, type StateService, type StateUpdate, type StateWriteResult,
} from '../modules/state/service.js';
import type { WorldService } from '../modules/worlds/service.js';

type Dependencies = {
  cache: RuntimeCache;
  worlds: Pick<WorldService, 'setState'>;
  sessions: Pick<SessionService, 'setState' | 'setEntryState' | 'listIdsByWorld'>;
  state: Pick<StateService, 'requireGlobal' | 'requireSession' | 'requireMessage' | 'prepareGlobalPatch' | 'prepareSessionPatch' | 'prepareMessagePatch' | 'getCurrentMessage' | 'describeChange'>;
  transaction: TransactionRunner;
  events: EventHub;
};
type GlobalSnapshot = Parameters<WorldService['setState']>[1];
type SessionSnapshot = Parameters<SessionService['setState']>[1];
type MessageSnapshot = Parameters<SessionService['setEntryState']>[2];
type StateScope = StateWriteResult['scope'];

function identifier(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) throw new AppError('INVALID_STATE_OWNER');
  return value;
}

function writeFailure(scope: StateScope, path: string, error: unknown): StateWriteResult {
  const validation = error instanceof StateValidationError ? error : undefined;
  const application = error instanceof AppError ? error : undefined;
  const errorCode = validation?.code ?? application?.code ?? 'INTERNAL_ERROR';
  const { message, status } = ERRORS[errorCode];
  const detail = validation
    ? validation.scope + (validation.path ? '.' + validation.path : '')
    : application?.detail;
  return {
    path, scope, success: false, errorCode,
    errorMessage: detail && status < 500 ? message + '：' + detail : message,
    ...(validation ? {
      stateScope: validation.scope, statePath: validation.path,
      ...(validation.rulePath === undefined ? {} : { rulePath: validation.rulePath }),
    } : {}),
  };
}

/** State prepares changes; this usecase persists through the owners of the state columns. */
export function createSetState({ worlds, sessions, state, transaction, events, cache }: Dependencies) {
  function assertWrite(scope: StateScope, ownerId: string): void {
    if (scope === 'global') cache.assertGlobalStateWrite(ownerId);
    else cache.assertStateWrite(ownerId);
  }

  function commit<T>(scope: StateScope, ownerId: string, path: string, write: () => T) {
    return transaction(() => {
      assertWrite(scope, ownerId);
      const read = () => scope === 'global' ? state.requireGlobal(ownerId)
        : scope === 'session' ? state.requireSession(ownerId) : state.getCurrentMessage(ownerId, path || undefined);
      const before = read();
      const value = write();
      const event = state.describeChange(scope, before, read(), path);
      const sessionIds = event === null ? [] : scope === 'global' ? sessions.listIdsByWorld(ownerId) : [ownerId];
      return { value, event, sessionIds };
    });
  }

  function publish(result: Pick<ReturnType<typeof commit>, 'event' | 'sessionIds'>): void {
    if (result.event === null) return;
    for (const sessionId of result.sessionIds) events.publish(sessionId, structuredClone(result.event));
  }

  function replace<T>(scope: StateScope, ownerId: string, write: () => T): T {
    const result = commit(scope, identifier(ownerId), '', write);
    publish(result);
    return result.value;
  }

  function patch(scope: StateScope, ownerId: string, updates: readonly StateUpdate[], apply: (update: StateUpdate) => void): StateWriteResult[] {
    assertWrite(scope, ownerId);
    return updates.map(update => {
      let result;
      try {
        // Each field commits separately. Failed writes never reach the publisher.
        result = commit(scope, ownerId, update.path, () => apply(update));
      } catch (error) {
        if (error instanceof AppError && error.code === 'STATE_WRITE_LOCKED') throw error;
        return writeFailure(scope, update.path, error);
      }
      // Delivery is outside the transaction/error mapping and precedes the next field.
      // EventHub isolates subscriber failures from committed writes.
      publish(result);
      return { path: update.path, scope, success: true, errorCode: null, errorMessage: '' };
    });
  }

  return {
    setGlobal(worldId: string, value: GlobalSnapshot): GlobalSnapshot {
      return replace('global', worldId, () => worlds.setState(worldId, value));
    },
    setSession(sessionId: string, value: SessionSnapshot): SessionSnapshot {
      return replace('session', sessionId, () => sessions.setState(sessionId, value));
    },
    /** NULL restores inheritance; this writes only the selected entry's own snapshot. */
    setMessage(sessionId: string, entryId: string, value: MessageSnapshot): MessageSnapshot {
      identifier(entryId);
      return replace('message', sessionId, () => sessions.setEntryState(sessionId, entryId, value));
    },
    patchGlobal(worldId: string, updates: readonly StateUpdate[]): StateWriteResult[] {
      identifier(worldId);
      assertWrite('global', worldId);
      state.requireGlobal(worldId);
      return patch('global', worldId, updates, update => {
        const result = state.prepareGlobalPatch(worldId, update);
        if (result.changed) worlds.setState(worldId, result.snapshot);
      });
    },
    patchSession(sessionId: string, updates: readonly StateUpdate[]): StateWriteResult[] {
      identifier(sessionId);
      assertWrite('session', sessionId);
      state.requireSession(sessionId);
      return patch('session', sessionId, updates, update => {
        const result = state.prepareSessionPatch(sessionId, update);
        if (result.changed) sessions.setState(sessionId, result.snapshot);
      });
    },
    patchMessage(sessionId: string, entryId: string, updates: readonly StateUpdate[]): StateWriteResult[] {
      identifier(sessionId); identifier(entryId);
      assertWrite('message', sessionId);
      state.requireSession(sessionId);
      state.requireMessage(sessionId, entryId);
      return patch('message', sessionId, updates, update => {
        const result = state.prepareMessagePatch(sessionId, entryId, update);
        if (result.changed) sessions.setEntryState(sessionId, entryId, result.snapshot);
      });
    },
  };
}

export type SetState = ReturnType<typeof createSetState>;
