import { AppError } from '../errors.js';
import type { SessionService } from '../modules/sessions/service.js';
import type { WorldService } from '../modules/worlds/service.js';

type Dependencies = {
  worlds: Pick<WorldService, 'setState'>;
  sessions: Pick<SessionService, 'setState' | 'setEntryState'>;
};
type GlobalSnapshot = Parameters<WorldService['setState']>[1];
type SessionSnapshot = Parameters<SessionService['setState']>[1];
type MessageSnapshot = Parameters<SessionService['setEntryState']>[2];

function identifier(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) throw new AppError('INVALID_STATE_OWNER');
  return value;
}

/** Write complete scope snapshots through the module that owns each stored column. */
export function createSetState({ worlds, sessions }: Dependencies) {
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
  };
}

export type SetState = ReturnType<typeof createSetState>;
