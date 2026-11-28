import { narrativeQuery } from '../http/narrative-query.js';
import { Hono } from 'hono';
import { encodeCursor } from '../http/pagination.js';
import { AppError } from '../errors.js';
import { readJson, success } from '../http/response.js';
import { assertAccepting, requireSessionAccess, type SessionAccessCheck } from '../http/session-access.js';
import type { SessionService } from '../modules/sessions/service.js';
import type { NarrativeUsecases, SubmitInput, RegenerateInput } from '../usecases/narrative/index.js';

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
    assertAccepting(shutdownSignal);
    if (Object.hasOwn(body, 'sessionId')) throw new AppError('INVALID_REQUEST');
    return success(c, narrative.submit({ ...body, sessionId }), 202);
  });
  routes.post('/:sessionId/narrative/runs/regenerate', async c => {
    const sessionId = c.req.param('sessionId');
    await requireSessionAccess(sessions, sessionId, c.req.raw, canAccessSession, shutdownSignal);
    const body = await readJson<Omit<RegenerateInput, 'sessionId'>>(c);
    assertAccepting(shutdownSignal);
    if (Object.hasOwn(body, 'sessionId')) throw new AppError('INVALID_REQUEST');
    return success(c, narrative.regenerate({ ...body, sessionId }), 202);
  });
  routes.post('/:sessionId/narrative/runs/:runId/stop', async c => {
    const sessionId = c.req.param('sessionId');
    await requireSessionAccess(sessions, sessionId, c.req.raw, canAccessSession, shutdownSignal);
    const body = await readJson<{ assistantEntryId: string }>(c);
    assertAccepting(shutdownSignal);
    if (Object.keys(body).length !== 1 || typeof body.assistantEntryId !== 'string') throw new AppError('INVALID_REQUEST');
    return success(c, narrative.stop(sessionId, c.req.param('runId'), body.assistantEntryId));
  });
  routes.get('/:sessionId/narrative/runs', async c => {
    const sessionId = c.req.param('sessionId');
    await requireSessionAccess(sessions, sessionId, c.req.raw, canAccessSession, shutdownSignal);
    const scope = 'runs:' + sessionId;
    const { nextPageKey, ...page } = narrative.list(sessionId, narrativeQuery(sessionId, c.req.query()));
    return success(c, { ...page, nextCursor: nextPageKey === null ? null : encodeCursor(scope, { beforePageKey: nextPageKey }) });
  });
  routes.get('/:sessionId/narrative/runs/:runId', async c => {
    const sessionId = c.req.param('sessionId');
    await requireSessionAccess(sessions, sessionId, c.req.raw, canAccessSession, shutdownSignal);
    return success(c, narrative.get(sessionId, c.req.param('runId')));
  });
  routes.get('/:sessionId/narrative/usage', async c => {
    const sessionId = c.req.param('sessionId');
    await requireSessionAccess(sessions, sessionId, c.req.raw, canAccessSession, shutdownSignal);
    return success(c, narrative.usage(sessionId));
  });
  return routes;
}
