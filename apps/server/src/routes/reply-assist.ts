import { Hono } from 'hono';
import { readJson, success } from '../http/response.js';
import { requireSessionAccess } from '../http/session-access.js';
import type { SessionAccessCheck } from '../http/session-access.js';
import type { SessionService } from '../modules/sessions/service.js';
import type { createReplyAssist } from '../usecases/reply-assist/index.js';

export function createReplyAssistRoutes({ sessions, canAccessSession, shutdownSignal, replyAssist }:
  { sessions: SessionService; canAccessSession?: SessionAccessCheck; shutdownSignal: AbortSignal; replyAssist: ReturnType<typeof createReplyAssist> }) {
  const routes = new Hono();
  routes.post('/:id/reply-assist', async c => {
    const id = c.req.param('id');
    await requireSessionAccess(sessions, id, c.req.raw, canAccessSession, shutdownSignal);
    return success(c, replyAssist.submit(id, await readJson(c)), 202);
  });
  routes.post('/:id/reply-assist/:requestId/stop', async c => {
    const id = c.req.param('id');
    await requireSessionAccess(sessions, id, c.req.raw, canAccessSession, shutdownSignal);
    return success(c, replyAssist.stop(id, c.req.param('requestId')));
  });
  return routes;
}
