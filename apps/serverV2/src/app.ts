import { Hono } from 'hono';
import type { EventHub } from './events/event-hub.js';
import { createSessionEventsResponse } from './events/session-events.js';

export type AppOptions = {
  events: EventHub;
  // True means the session exists and this request may access it.
  canAccessSession?: (sessionId: string, request: Request) => boolean | Promise<boolean>;
};

export function createApp({ events, canAccessSession }: AppOptions) {
  const app = new Hono();
  const shutdown = new AbortController();
  app.use('*', async (c, next) => {
    if (shutdown.signal.aborted) return c.json({ errorCode: 'SERVER_SHUTTING_DOWN' }, 503);
    await next();
  });
  app.onError(() => new Response(JSON.stringify({ errorCode: 'INTERNAL_ERROR' }), {
    status: 500, headers: { 'content-type': 'application/json' },
  }));
  app.notFound(c => c.json({ errorCode: 'NOT_FOUND' }, 404));
  // Liveness only: V2 does not connect to business storage yet.
  app.get('/health', c => c.json({ ok: true }));
  app.get('/api/v1/sessions/:id/events', async c => {
    if (!canAccessSession) return c.json({ errorCode: 'SESSION_ACCESS_UNAVAILABLE' }, 503);
    const sessionId = c.req.param('id');
    const allowed = await canAccessSession(sessionId, c.req.raw);
    if (shutdown.signal.aborted) return c.json({ errorCode: 'SERVER_SHUTTING_DOWN' }, 503);
    // Do not reveal whether an inaccessible session exists.
    if (!allowed) return c.json({ errorCode: 'SESSION_NOT_FOUND' }, 404);
    return createSessionEventsResponse(events, sessionId, c.req.raw.signal, shutdown.signal);
  });
  return Object.assign(app, { shutdown: () => shutdown.abort() });
}
