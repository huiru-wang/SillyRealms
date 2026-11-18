import { Hono } from 'hono';
import { AppError } from '../errors.js';
import type { EventHub } from '../events/event-hub.js';
import { createSessionEventsResponse } from '../events/session-events.js';
import { numberQuery, readJson, success } from '../http/response.js';
import { requireSessionAccess, type SessionAccessCheck } from '../http/session-access.js';
import type { AppendEntryInput, CreateSessionInput, SessionService, UpdateEntryInput, UpdateSessionInput } from '../sessions/service.js';

export type SessionRouteOptions = {
  events: EventHub;
  sessions: SessionService;
  canAccessSession?: SessionAccessCheck;
  shutdownSignal: AbortSignal;
};

export function createSessionRoutes({ events, sessions, canAccessSession, shutdownSignal }: SessionRouteOptions) {
  const routes = new Hono();
  const access = (sessionId: string, request: Request) =>
    requireSessionAccess(sessions, sessionId, request, canAccessSession, shutdownSignal);

  routes.get('/', async c => {
    const beforeTime = numberQuery(c, 'before_updated_at'), beforeId = c.req.query('before_id');
    if ((beforeTime === undefined) !== (beforeId === undefined)) {
      throw new AppError('INVALID_REQUEST', 'before_updated_at 与 before_id 必须同时提供');
    }
    const items = sessions.list({
      world_id: c.req.query('world_id'), limit: numberQuery(c, 'limit'),
      before: beforeTime === undefined ? undefined : { updated_at: beforeTime, id: beforeId! },
    });
    if (!canAccessSession) return success(c, { items });
    const accessible = [];
    for (const item of items) {
      try {
        await access(item.id, c.req.raw);
        accessible.push(item);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'SESSION_NOT_FOUND') throw error;
      }
    }
    return success(c, { items: accessible });
  });

  routes.post('/', async c => {
    const input = await readJson<CreateSessionInput>(c);
    return success(c, { item: sessions.create(input) }, 201);
  });

  routes.get('/:id', async c => {
    const id = c.req.param('id');
    await access(id, c.req.raw);
    return success(c, { item: sessions.require(id) });
  });

  routes.patch('/:id', async c => {
    const id = c.req.param('id');
    await access(id, c.req.raw);
    return success(c, { item: sessions.update(id, await readJson<UpdateSessionInput>(c)) });
  });

  routes.delete('/:id', async c => {
    const id = c.req.param('id');
    await access(id, c.req.raw);
    if (!sessions.delete(id)) throw new AppError('SESSION_NOT_FOUND');
    return success(c, { id });
  });

  routes.get('/:id/entries', async c => {
    const id = c.req.param('id');
    await access(id, c.req.raw);
    return success(c, { items: sessions.listEntries(id, { after_seq: numberQuery(c, 'after_seq'), limit: numberQuery(c, 'limit') }) });
  });

  routes.post('/:id/entries', async c => {
    const id = c.req.param('id');
    await access(id, c.req.raw);
    const input = await readJson<AppendEntryInput>(c);
    if (Object.hasOwn(input, 'metrics_json')) throw new AppError('INVALID_REQUEST', '模型调用计量仅允许由服务内部写入');
    return success(c, { item: sessions.appendEntry(id, input) }, 201);
  });

  routes.get('/:id/entries/:entryId', async c => {
    const id = c.req.param('id');
    await access(id, c.req.raw);
    const item = sessions.getEntry(id, c.req.param('entryId'));
    if (!item) throw new AppError('ENTRY_NOT_FOUND');
    return success(c, { item });
  });

  routes.patch('/:id/entries/:entryId', async c => {
    const id = c.req.param('id');
    await access(id, c.req.raw);
    return success(c, { item: sessions.updateEntry(id, c.req.param('entryId'), await readJson<UpdateEntryInput>(c)) });
  });

  routes.get('/:id/history', async c => {
    const id = c.req.param('id');
    await access(id, c.req.raw);
    return success(c, { items: sessions.getHistory(id) });
  });

  routes.get('/:id/runs/:runId/entries', async c => {
    const id = c.req.param('id');
    await access(id, c.req.raw);
    return success(c, { items: sessions.listRunEntries(id, c.req.param('runId')) });
  });

  routes.get('/:id/events', async c => {
    const id = c.req.param('id');
    await access(id, c.req.raw);
    // Hono dispatches HEAD through GET; creating a stream here would leave a discarded subscription.
    if (c.req.raw.method === 'HEAD') return new Response(null, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      },
    });
    return createSessionEventsResponse(events, id, c.req.raw.signal, shutdownSignal);
  });
  return routes;
}
