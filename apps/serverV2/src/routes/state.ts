import { Hono, type Context } from 'hono';
import { AppError } from '../errors.js';
import { readJson, success } from '../http/response.js';
import { requireSessionAccess, type SessionAccessCheck } from '../http/session-access.js';
import type { SessionService } from '../modules/sessions/service.js';
import type { StateService } from '../modules/state/service.js';
import type { SetState } from '../usecases/set-state.js';

type ObjectSnapshot = ReturnType<StateService['requireGlobal']>;
type MessageSnapshot = ReturnType<StateService['getMessage']>;

export type StateRouteOptions = {
  state: StateService;
  setState: SetState;
  sessions: SessionService;
  canAccessSession?: SessionAccessCheck;
  shutdownSignal: AbortSignal;
};

async function readState(c: Context): Promise<unknown> {
  const body = await readJson<{ state?: unknown }>(c);
  if (!Object.hasOwn(body, 'state') || Object.keys(body).length !== 1) {
    throw new AppError('INVALID_REQUEST', '请求正文必须且只能包含 state 字段');
  }
  return body.state!;
}

async function readObjectState(c: Context): Promise<ObjectSnapshot> {
  const state = await readState(c);
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    throw new AppError('INVALID_REQUEST', '此作用域的 state 必须为完整 JSON 对象');
  }
  return state as ObjectSnapshot;
}

async function readMessageState(c: Context): Promise<MessageSnapshot> {
  const state = await readState(c);
  if (state !== null && !Array.isArray(state)) {
    throw new AppError('INVALID_REQUEST', '消息 state 必须为完整 JSON 数组或 null');
  }
  return state;
}

export function createStateRoutes({ state, setState, sessions, canAccessSession, shutdownSignal }: StateRouteOptions) {
  const routes = new Hono();
  const access = (sessionId: string, request: Request) =>
    requireSessionAccess(sessions, sessionId, request, canAccessSession, shutdownSignal);

  routes.get('/worlds/:worldId/state', c =>
    success(c, { item: state.requireGlobal(c.req.param('worldId')) }));

  routes.put('/worlds/:worldId/state', async c =>
    success(c, { item: setState.setGlobal(c.req.param('worldId'), await readObjectState(c)) }));

  routes.get('/sessions/:id/state', async c => {
    const id = c.req.param('id');
    await access(id, c.req.raw);
    return success(c, { item: state.requireSession(id) });
  });

  routes.put('/sessions/:id/state', async c => {
    const id = c.req.param('id');
    await access(id, c.req.raw);
    return success(c, { item: setState.setSession(id, await readObjectState(c)) });
  });

  routes.get('/sessions/:id/entries/:entryId/state', async c => {
    const id = c.req.param('id');
    await access(id, c.req.raw);
    return success(c, { item: state.requireMessage(id, c.req.param('entryId')) });
  });

  routes.put('/sessions/:id/entries/:entryId/state', async c => {
    const id = c.req.param('id');
    await access(id, c.req.raw);
    return success(c, { item: setState.setMessage(id, c.req.param('entryId'), await readMessageState(c)) });
  });
  return routes;
}
