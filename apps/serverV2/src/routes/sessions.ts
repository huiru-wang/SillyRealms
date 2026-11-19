import { Hono } from 'hono';
import { AppError } from '../errors.js';
import type { EventHub } from '../infrastructure/events/event-hub.js';
import { createSessionEventsResponse } from '../infrastructure/events/session-events.js';
import { decodeCursor, encodeCursor } from '../http/pagination.js';
import { numberQuery, readJson, success } from '../http/response.js';
import { requireSessionAccess, type SessionAccessCheck } from '../http/session-access.js';
import type {
  AppendEntryInput, CreateSessionInput, Session, SessionListOptions, SessionService, UpdateEntryInput, UpdateSessionInput,
} from '../modules/sessions/service.js';
import type { WorldService } from '../modules/worlds/service.js';
import type { AppendEntry } from '../usecases/append-entry.js';

export type SessionSummary = Pick<Session, 'id' | 'worldId' | 'presetId' | 'apiModelConfigId' | 'title' | 'updatedAt'>
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
      id: item.id, worldId: item.worldId, presetId: item.presetId, apiModelConfigId: item.apiModelConfigId,
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
  appendEntry: AppendEntry;
  canAccessSession?: SessionAccessCheck;
  shutdownSignal: AbortSignal;
};

export function createSessionRoutes({ events, sessions, worlds, appendEntry, canAccessSession, shutdownSignal }: SessionRouteOptions) {
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
    return success(c, { item: projectSession(sessions.create(input), worlds) }, 201);
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

  routes.get('/:id/entries', async c => {
    const id = c.req.param('id');
    await access(id, c.req.raw);
    return success(c, { items: sessions.listEntries(id, { afterSeq: numberQuery(c, 'afterSeq'), limit: numberQuery(c, 'limit') }) });
  });

  routes.post('/:id/entries', async c => {
    const id = c.req.param('id');
    await access(id, c.req.raw);
    const input = await readJson<AppendEntryInput>(c);
    if (Object.hasOwn(input, 'metrics')) throw new AppError('INVALID_REQUEST', '模型调用计量仅允许由服务内部写入');
    return success(c, { item: appendEntry(id, input) }, 201);
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
