import { AppError, ERRORS } from '../errors.js';
import type { TransactionRunner } from '../infrastructure/database/transaction.js';
import type { SessionService } from '../modules/sessions/service.js';
import {
  StateValidationError, type StateService, type StateUpdate, type StateWriteResult,
} from '../modules/state/service.js';
import type { WorldService } from '../modules/worlds/service.js';

type Dependencies = {
  worlds: Pick<WorldService, 'setState'>;
  sessions: Pick<SessionService, 'setState' | 'setEntryState'>;
  state: Pick<StateService, 'requireGlobal' | 'requireSession' | 'requireMessage' | 'prepareGlobalPatch' | 'prepareSessionPatch' | 'prepareMessagePatch'>;
  transaction: TransactionRunner;
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
export function createSetState({ worlds, sessions, state, transaction }: Dependencies) {
  function patch(scope: StateScope, updates: readonly StateUpdate[], apply: (update: StateUpdate) => void): StateWriteResult[] {
    return updates.map(update => {
      try {
        // Each read/modify/write is its own synchronous transaction, including successful no-ops.
        transaction(() => apply(update));
        return { path: update.path, scope, success: true, errorCode: null, errorMessage: '' };
      } catch (error) {
        return writeFailure(scope, update.path, error);
      }
    });
  }

  return {
    setGlobal(worldId: string, value: GlobalSnapshot): GlobalSnapshot {
      return worlds.setState(identifier(worldId), value);
    },
    setSession(sessionId: string, value: SessionSnapshot): SessionSnapshot {
      return sessions.setState(identifier(sessionId), value);
    },
    /** NULL restores inheritance; this writes only the selected entry's own snapshot. */
    setMessage(sessionId: string, entryId: string, value: MessageSnapshot): MessageSnapshot {
      return sessions.setEntryState(identifier(sessionId), identifier(entryId), value);
    },
    patchGlobal(worldId: string, updates: readonly StateUpdate[]): StateWriteResult[] {
      identifier(worldId);
      state.requireGlobal(worldId);
      return patch('global', updates, update => {
        const result = state.prepareGlobalPatch(worldId, update);
        if (result.changed) worlds.setState(worldId, result.snapshot);
      });
    },
    patchSession(sessionId: string, updates: readonly StateUpdate[]): StateWriteResult[] {
      identifier(sessionId);
      state.requireSession(sessionId);
      return patch('session', updates, update => {
        const result = state.prepareSessionPatch(sessionId, update);
        if (result.changed) sessions.setState(sessionId, result.snapshot);
      });
    },
    patchMessage(sessionId: string, entryId: string, updates: readonly StateUpdate[]): StateWriteResult[] {
      identifier(sessionId); identifier(entryId);
      state.requireSession(sessionId);
      state.requireMessage(sessionId, entryId);
      return patch('message', updates, update => {
        const result = state.prepareMessagePatch(sessionId, entryId, update);
        if (result.changed) sessions.setEntryState(sessionId, entryId, result.snapshot);
      });
    },
  };
}

export type SetState = ReturnType<typeof createSetState>;
