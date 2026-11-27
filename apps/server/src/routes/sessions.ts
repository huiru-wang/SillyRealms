import { Hono } from 'hono';
import { AppError } from '../errors.js';
import type { EventHub } from '../infrastructure/events/event-hub.js';
import { createSessionEventsResponse } from '../infrastructure/events/session-events.js';
import { decodeCursor, encodeCursor } from '../http/pagination.js';
import { numberQuery, readJson, success } from '../http/response.js';
import { requireSessionAccess, type SessionAccessCheck } from '../http/session-access.js';
import type {
  Session, SessionListOptions, SessionService, UpdateSessionInput,
} from '../modules/sessions/service.js';
import type { WorldService } from '../modules/worlds/service.js';
import type { CreateSession, CreateSessionInput } from '../usecases/create-session.js';

export type SessionSummary = Pick<Session, 'id' | 'worldId' | 'runtimeConfig' | 'title' | 'updatedAt'>
  & { worldName: string; cover: string | null };
export type SessionView = SessionSummary & Pick<Session, 'userCharacterId' | 'tipEntryId' | 'createdAt'>;

function projectSessions(items: readonly Session[], worlds: WorldService): SessionSummary[] {
  const cache = new Map<string, Pick<SessionSummary, 'worldName' | 'cover'>>();
  return items.map(item => {
    let world = cache.get(item.worldId);
    if (!world) {
      const current = worlds.require(item.worldId);
      world = { worldName: current.name, cover: current.cover };
      cache.set(item.worldId, world);
    }
    return {
      id: item.id, worldId: item.worldId, runtimeConfig: item.runtimeConfig,
      title: item.title, updatedAt: item.updatedAt, ...world,
    };
  });
}

function projectSession(item: Session, worlds: WorldService): SessionView {
  return {
    ...projectSessions([item], worlds)[0]!,
    userCharacterId: item.userCharacterId, tipEntryId: item.tipEntryId, createdAt: item.createdAt,
  };
}

export type SessionRouteOptions = {
  events: EventHub;
  sessions: SessionService;
  worlds: WorldService;
  createSession: CreateSession;
  canAccessSession?: SessionAccessCheck;
  shutdownSignal: AbortSignal;
  streamShutdownSignal?: AbortSignal;
};

export function createSessionRoutes({ events, sessions, worlds, createSession, canAccessSession, shutdownSignal, streamShutdownSignal = shutdownSignal }: SessionRouteOptions) {
  const routes = new Hono();
  const access = (sessionId: string, request: Request) =>
    requireSessionAccess(sessions, sessionId, request, canAccessSession, shutdownSignal);

  routes.get('/', async c => {
    const worldId = c.req.query('worldId'), limit = numberQuery(c, 'limit') ?? 100;
    if (limit < 1 || limit > 1000) throw new AppError('INVALID_REQUEST', 'limit 必须介于 1 与 1000');
    const scope = 'sessions:' + (worldId ?? '');
    const cursor = c.req.query('cursor');
    let before = cursor === undefined ? undefined : decodeCursor(cursor, scope) as SessionListOptions['before'];
    const page = (items: Session[], hasMore: boolean) => {
      const last = items.at(-1);
      return success(c, {
        items: projectSessions(items, worlds), hasMore,
        nextCursor: hasMore && last ? encodeCursor(scope, { updatedAt: last.updatedAt, id: last.id }) : null,
      });
    };
    if (!canAccessSession) {
      const result = sessions.listPage({ worldId, limit, before });
      return page(result.items, result.hasMore);
    }
    const accessible: Session[] = [];
    // Look ahead to one accessible item, so hidden rows cannot truncate pages or consume the next visible item.
    while (accessible.length <= limit) {
      const result = sessions.listPage({ worldId, limit, before });
      for (const item of result.items) {
        try {
          await access(item.id, c.req.raw);
          accessible.push(item);
          if (accessible.length > limit) break;
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== 'SESSION_NOT_FOUND') throw error;
        }
      }
      if (accessible.length > limit || !result.hasMore) break;
      const last = result.items.at(-1)!;
      before = { updatedAt: last.updatedAt, id: last.id };
    }
    return page(accessible.slice(0, limit), accessible.length > limit);
  });

  routes.post('/', async c => {
    const input = await readJson<CreateSessionInput>(c);
    const result = createSession(input);
    return success(c, { item: projectSession(result.item, worlds), entry: result.entry }, 201);
  });

  routes.get('/:id', async c => {
    const id = c.req.param('id');
    await access(id, c.req.raw);
    return success(c, { item: projectSession(sessions.require(id), worlds) });
  });

  routes.patch('/:id', async c => {
    const id = c.req.param('id');
    await access(id, c.req.raw);
    return success(c, { item: projectSession(sessions.update(id, await readJson<UpdateSessionInput>(c)), worlds) });
  });

  routes.delete('/:id', async c => {
    const id = c.req.param('id');
    await access(id, c.req.raw);
    if (!sessions.delete(id)) throw new AppError('SESSION_NOT_FOUND');
    return success(c, { id });
  });

  routes.get('/:id/entries/:entryId/character-sprites', async c => {
    const id = c.req.param('id'), messageId = c.req.param('entryId');
    await access(id, c.req.raw);
    return success(c, { sessionId: id, messageId, result: sessions.getMessageCharacterSprites(id, messageId) });
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
    return createSessionEventsResponse(events, id, c.req.raw.signal, streamShutdownSignal);
  });
  return routes;
}
