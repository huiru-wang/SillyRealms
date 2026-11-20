import { narrativeQuery } from '../http/narrative-query.js';
import { Hono } from 'hono';
import { encodeCursor } from '../http/pagination.js';
import { AppError } from '../errors.js';
import { readJson, success } from '../http/response.js';
import { requireSessionAccess, type SessionAccessCheck } from '../http/session-access.js';
import type { SessionService } from '../modules/sessions/service.js';
import type { NarrativeUsecases, SubmitInput } from '../usecases/narrative/index.js';

export type NarrativeRouteOptions = {
  sessions: SessionService;
  narrative: NarrativeUsecases;
  canAccessSession?: SessionAccessCheck;
  shutdownSignal: AbortSignal;
};

export function createNarrativeRoutes({ sessions, narrative, canAccessSession, shutdownSignal }: NarrativeRouteOptions) {
  const routes = new Hono();
  routes.post('/:sessionId/narrative/runs', async c => {
    const sessionId = c.req.param('sessionId');
    await requireSessionAccess(sessions, sessionId, c.req.raw, canAccessSession, shutdownSignal);
    const body = await readJson<Omit<SubmitInput, 'sessionId'>>(c);
    if (Object.hasOwn(body, 'sessionId')) throw new AppError('INVALID_REQUEST');
    return success(c, narrative.submit({ ...body, sessionId }), 202);
  });
  routes.post('/:sessionId/narrative/runs/:runId/stop', async c => {
    const sessionId = c.req.param('sessionId');
    await requireSessionAccess(sessions, sessionId, c.req.raw, canAccessSession, shutdownSignal);
    return success(c, narrative.stop(sessionId, c.req.param('runId')));
  });
  routes.get('/:sessionId/narrative/runs', async c => {
    const sessionId = c.req.param('sessionId');
    await requireSessionAccess(sessions, sessionId, c.req.raw, canAccessSession, shutdownSignal);
    const scope = 'narrative:' + sessionId;
    const { nextBeforeSeq, ...page } = narrative.list(sessionId, narrativeQuery(sessionId, c.req.query()));
    return success(c, { ...page, nextCursor: nextBeforeSeq === null ? null : encodeCursor(scope, { beforeSeq: nextBeforeSeq }) });
  });
  routes.get('/:sessionId/narrative/usage', async c => {
    const sessionId = c.req.param('sessionId');
    await requireSessionAccess(sessions, sessionId, c.req.raw, canAccessSession, shutdownSignal);
    return success(c, narrative.usage(sessionId));
  });
  return routes;
}
