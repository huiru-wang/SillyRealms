import { AppError } from '../errors.js';
import type { SessionService } from '../modules/sessions/service.js';

export type SessionAccessCheck = (sessionId: string, request: Request) => boolean | Promise<boolean>;

export function assertAccepting(shutdownSignal?: AbortSignal) {
  if (shutdownSignal?.aborted) throw new AppError(shutdownSignal.reason === 'STORAGE_UNAVAILABLE' ? 'STORAGE_UNAVAILABLE' : 'SERVER_SHUTTING_DOWN');
}

/** HTTP access checks never replace the session service's existence check. */
export async function requireSessionAccess(
  sessions: SessionService,
  sessionId: string,
  request: Request,
  canAccessSession?: SessionAccessCheck,
  shutdownSignal?: AbortSignal,
): Promise<void> {
  assertAccepting(shutdownSignal);
  if (!sessionId.trim() || sessionId !== sessionId.trim() || !sessions.get(sessionId)) {
    throw new AppError('SESSION_NOT_FOUND');
  }
  const allowed = canAccessSession ? await canAccessSession(sessionId, request) : true;
  // The connection may have been closed while the access adapter was awaiting.
  assertAccepting(shutdownSignal);
  if (!allowed || !sessions.get(sessionId)) throw new AppError('SESSION_NOT_FOUND');
}
