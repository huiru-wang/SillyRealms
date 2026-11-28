import { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { readJson, success } from '../http/response.js';
import { assertAccepting, requireSessionAccess, type SessionAccessCheck } from '../http/session-access.js';
import type { SessionService } from '../modules/sessions/service.js';
import type { StateUpdate } from '../modules/state/service.js';
import type { StateTarget, StateUsecase } from '../usecases/state.js';

const id = z.string().min(1).refine(value => value === value.trim());
const queryPaths = z.array(z.string()).optional();
const targetSchema = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('global'), worldId: id }),
  z.strictObject({ scope: z.literal('session'), sessionId: id }),
  z.strictObject({ scope: z.literal('message'), sessionId: id, entryId: id }),
]);

function readUpdates(value: unknown): StateUpdate[] {
  if (!Array.isArray(value)) throw new AppError('INVALID_REQUEST', 'updates 必须为数组');
  for (const update of value) {
    if (update === null || typeof update !== 'object' || Array.isArray(update)
      || Object.keys(update).length !== 2 || !Object.hasOwn(update, 'path') || typeof update.path !== 'string'
      || update.path.length === 0 || !Object.hasOwn(update, 'value')) {
      throw new AppError('INVALID_REQUEST', '每个更新必须且只能包含非空 path 和 value');
    }
  }
  return value;
}

export function createStateRoutes({ state, sessions, canAccessSession, shutdownSignal }: {
  state: StateUsecase;
  sessions: SessionService;
  canAccessSession?: SessionAccessCheck;
  shutdownSignal: AbortSignal;
}) {
  const routes = new Hono();
  async function authorize(target: StateTarget, request: Request) {
    if (target.scope !== 'global') {
      await requireSessionAccess(sessions, target.sessionId, request, canAccessSession, shutdownSignal);
    }
  }

  routes.post('/query', async c => {
    const { paths, ...owner } = await readJson<Record<string, unknown>>(c);
    const target = targetSchema.parse(owner);
    await authorize(target, c.req.raw);
    assertAccepting(shutdownSignal);
    return success(c, state.query(target, queryPaths.parse(paths)));
  });
  routes.post('/update', async c => {
    const { updates, ...owner } = await readJson<Record<string, unknown>>(c);
    const target = targetSchema.parse(owner);
    await authorize(target, c.req.raw);
    assertAccepting(shutdownSignal);
    return success(c, state.update(target, readUpdates(updates)));
  });
  return routes;
}
