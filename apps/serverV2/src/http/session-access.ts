import { AppError } from '../errors.js';
import type { SessionService } from '../modules/sessions/service.js';

export type SessionAccessCheck = (sessionId: string, request: Request) => boolean | Promise<boolean>;

/** HTTP access checks never replace the session service's existence check. */
export async function requireSessionAccess(
  sessions: SessionService,
  sessionId: string,
  request: Request,
  canAccessSession?: SessionAccessCheck,
  shutdownSignal?: AbortSignal,
): Promise<void> {
  if (shutdownSignal?.aborted) throw new AppError('SERVER_SHUTTING_DOWN');
  if (!sessionId.trim() || sessionId !== sessionId.trim() || !sessions.get(sessionId)) {
    throw new AppError('SESSION_NOT_FOUND');
  }
  const allowed = canAccessSession ? await canAccessSession(sessionId, request) : true;
  // The connection may have been closed while the access adapter was awaiting.
  if (shutdownSignal?.aborted) throw new AppError('SERVER_SHUTTING_DOWN');
  if (!allowed || !sessions.get(sessionId)) throw new AppError('SESSION_NOT_FOUND');
}
