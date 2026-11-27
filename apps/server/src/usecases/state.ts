import type { RuntimeCache } from '../infrastructure/cache/index.js';
import { AppError, ERRORS } from '../errors.js';
import type { EventHub } from '../infrastructure/events/event-hub.js';
import type { TransactionRunner } from '../infrastructure/database/transaction.js';
import type { SessionService } from '../modules/sessions/service.js';
import {
  StateValidationError, type StateService, type StateQueryRow, type StateUpdate, type StateWriteResult,
} from '../modules/state/service.js';
import type { WorldService } from '../modules/worlds/service.js';

type Dependencies = {
  cache: RuntimeCache;
  worlds: Pick<WorldService, 'require' | 'setState'>;
  sessions: Pick<SessionService, 'setState' | 'setEntryState' | 'listIdsByWorld' | 'require'>;
  state: Pick<StateService, 'requireGlobal' | 'requireSession' | 'requireMessage' | 'selectPaths' | 'prepareObjectPatch' | 'prepareMessagePatch' | 'getCurrentMessage' | 'describeChange'>;
  transaction: TransactionRunner;
  events: EventHub;
};
export type StateTarget =
  | { scope: 'global'; worldId: string }
  | { scope: 'session'; sessionId: string }
  | { scope: 'message'; sessionId: string; entryId: string };

type StateScope = StateTarget['scope'];

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

export function createStateUsecase({ worlds, sessions, state, transaction, events, cache }: Dependencies) {
  function snapshot(target: StateTarget) {
    switch (target.scope) {
      case 'global': return state.requireGlobal(target.worldId);
      case 'session': return state.requireSession(target.sessionId);
      case 'message': return state.requireMessage(target.sessionId, target.entryId);
    }
  }

  function assertWrite(target: StateTarget) {
    if (target.scope === 'global') cache.assertGlobalStateWrite(target.worldId);
    else cache.assertStateWrite(target.sessionId, undefined, sessions.require(target.sessionId).worldId);
  }

  function writeField(target: StateTarget, update: StateUpdate) {
    const { scope } = target;
    if (scope === 'global') {
      const world = worlds.require(target.worldId);
      const patch = state.prepareObjectPatch(scope, world.state, world.stateDefinition, update);
      if (!patch.changed) return null;
      const saved = worlds.setState(target.worldId, patch.snapshot);
      return state.describeChange(scope, world.state, saved, update.path);
    }

    const session = sessions.require(target.sessionId);
    const definition = worlds.require(session.worldId).stateDefinition;
    if (scope === 'session') {
      const patch = state.prepareObjectPatch(scope, session.state, definition, update);
      if (!patch.changed) return null;
      const saved = sessions.setState(session.id, patch.snapshot);
      return state.describeChange(scope, session.state, saved, update.path);
    }

    const inherited = state.requireMessage(session.id, target.entryId);
    const patch = state.prepareMessagePatch(inherited, definition, update);
    if (!patch.changed) return null;
    // A historical write only affects subscribers when the current tip inherits it.
    const before = state.getCurrentMessage(session.id, update.path);
    sessions.setEntryState(session.id, target.entryId, patch.snapshot);
    return state.describeChange(scope, before, state.getCurrentMessage(session.id, update.path), update.path);
  }

  return {
    query(target: StateTarget, paths?: readonly string[]): StateQueryRow[] {
      return state.selectPaths(snapshot(target), paths);
    },
    update(target: StateTarget, updates: readonly StateUpdate[]): StateWriteResult[] {
      assertWrite(target);
      snapshot(target); // Even an empty batch must address an existing target.
      return updates.map(update => {
        let committed;
        try {
          committed = transaction(() => {
            assertWrite(target);
            const event = writeField(target, update);
            if (!event) return null;
            const sessionIds = target.scope === 'global' ? sessions.listIdsByWorld(target.worldId) : [target.sessionId];
            return { event, sessionIds };
          });
        } catch (error) {
          if (error instanceof AppError && error.code === 'STATE_WRITE_LOCKED') throw error;
          return writeFailure(target.scope, update.path, error);
        }
        if (committed) {
          for (const sessionId of committed.sessionIds) events.publish(sessionId, structuredClone(committed.event));
        }
        return { path: update.path, scope: target.scope, success: true, errorCode: null, errorMessage: '' };
      });
    },
  };
}

export type StateUsecase = ReturnType<typeof createStateUsecase>;
