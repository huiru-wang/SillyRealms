import { Hono, type Context } from 'hono';
import { AppError } from '../errors.js';
import { readJson, success } from '../http/response.js';
import { requireSessionAccess, type SessionAccessCheck } from '../http/session-access.js';
import type { SessionService } from '../modules/sessions/service.js';
import type { StateService } from '../modules/state/service.js';
import type { SetState } from '../usecases/set-state.js';

type ObjectSnapshot = ReturnType<StateService['requireGlobal']>;
type MessageSnapshot = ReturnType<StateService['getMessage']>;
type StateUpdates = Parameters<SetState['patchGlobal']>[1];

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

async function readUpdates(c: Context): Promise<StateUpdates> {
  const body = await readJson<{ updates?: unknown }>(c);
  if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'updates') || !Array.isArray(body.updates)) {
    throw new AppError('INVALID_REQUEST', '请求正文必须且只能包含 updates 数组');
  }
  for (const update of body.updates) {
    if (update === null || typeof update !== 'object' || Array.isArray(update)
      || Object.keys(update).length !== 2 || !Object.hasOwn(update, 'path') || typeof update.path !== 'string'
      || update.path.length === 0 || !Object.hasOwn(update, 'value')) {
      throw new AppError('INVALID_REQUEST', '每个更新必须且只能包含非空 path 和 value');
    }
  }
  return body.updates as StateUpdates;
}

export function createStateRoutes({ state, setState, sessions, canAccessSession, shutdownSignal }: StateRouteOptions) {
  const routes = new Hono();
  const access = (sessionId: string, request: Request) =>
    requireSessionAccess(sessions, sessionId, request, canAccessSession, shutdownSignal);

  routes.get('/global/:worldId', c =>
    success(c, { item: state.requireGlobal(c.req.param('worldId')) }));

  routes.patch('/global/:worldId', async c =>
    success(c, setState.patchGlobal(c.req.param('worldId'), await readUpdates(c))));

  routes.put('/global/:worldId', async c =>
    success(c, { item: setState.setGlobal(c.req.param('worldId'), await readObjectState(c)) }));

  routes.get('/session/:sessionId', async c => {
    const sessionId = c.req.param('sessionId');
    await access(sessionId, c.req.raw);
    return success(c, { item: state.requireSession(sessionId) });
  });

  routes.patch('/session/:sessionId', async c => {
    const sessionId = c.req.param('sessionId');
    await access(sessionId, c.req.raw);
    return success(c, setState.patchSession(sessionId, await readUpdates(c)));
  });

  routes.put('/session/:sessionId', async c => {
    const sessionId = c.req.param('sessionId');
    await access(sessionId, c.req.raw);
    return success(c, { item: setState.setSession(sessionId, await readObjectState(c)) });
  });

  routes.get('/message/:sessionId/:entryId', async c => {
    const sessionId = c.req.param('sessionId');
    await access(sessionId, c.req.raw);
    return success(c, { item: state.requireMessage(sessionId, c.req.param('entryId')) });
  });

  routes.patch('/message/:sessionId/:entryId', async c => {
    const sessionId = c.req.param('sessionId');
    await access(sessionId, c.req.raw);
    return success(c, setState.patchMessage(sessionId, c.req.param('entryId'), await readUpdates(c)));
  });

  routes.put('/message/:sessionId/:entryId', async c => {
    const sessionId = c.req.param('sessionId');
    await access(sessionId, c.req.raw);
    return success(c, { item: setState.setMessage(sessionId, c.req.param('entryId'), await readMessageState(c)) });
  });
  return routes;
}
