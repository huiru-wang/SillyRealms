import { AppError } from '../errors.js';
import type { TransactionRunner } from '../infrastructure/database/transaction.js';
import type { SessionService } from '../modules/sessions/service.js';
import type { WorldService } from '../modules/worlds/service.js';

export type DeleteWorldOptions = {
  deleteSessions?: boolean;
  authorizeSession?: (sessionId: string) => Promise<void>;
};
export type DeleteWorld = (worldId: string, options?: DeleteWorldOptions) => Promise<boolean>;

type Dependencies = {
  worlds: Pick<WorldService, 'deleteRecord' | 'deleteFiles'>;
  sessions: Pick<SessionService, 'listIdsByWorld' | 'delete'>;
  transaction: TransactionRunner;
};

function requireConfirmation(count: number, changed = false): never {
  throw new AppError('WORLD_HAS_SESSIONS',
    (changed ? '关联会话已变化，' : '') + '当前关联 ' + count + ' 个会话。再次确认将删除世界、全部关联会话及消息记录，此操作无法撤销。');
}

/** Commit all database deletions together; file cleanup remains independently retryable. */
export function createDeleteWorld({ worlds, sessions, transaction }: Dependencies): DeleteWorld {
  return async (worldId, { deleteSessions = false, authorizeSession } = {}) => {
    let authorized: Set<string> | undefined;
    if (deleteSessions && authorizeSession) {
      const ids = sessions.listIdsByWorld(worldId);
      for (const id of ids) await authorizeSession(id);
      authorized = new Set(ids);
    }
    const dbDeleted = transaction(() => {
      const ids = sessions.listIdsByWorld(worldId);
      if (ids.length && !deleteSessions) requireConfirmation(ids.length);
      // An access adapter may have awaited while another session was created.
      if (authorized && ids.some(id => !authorized.has(id))) requireConfirmation(ids.length, true);
      for (const id of ids) sessions.delete(id);
      return worlds.deleteRecord(worldId);
    });
    const filesRemoved = await worlds.deleteFiles(worldId);
    return dbDeleted || filesRemoved;
  };
}
