import { AppError } from '../../errors.js';
import { assertActive, sameSource, sourceKey, sourceOf, track, type WorldUpdatesContext } from './context.js';
import { getWorldVersions, readIndex } from './read.js';
import { parseReleaseIndex } from './protocol.js';
import type { CheckTask, WorldVersions } from './types.js';

/** Startup and explicit refresh share the same in-flight request for a world/source. */
export function refreshWorldVersions(ctx: WorldUpdatesContext, worldId: string): Promise<WorldVersions> {
  assertActive(ctx);
  const source = sourceOf(ctx.worlds.require(worldId));
  if (!source) throw new AppError('WORLD_UPDATE_NO_SOURCE');
  const existing = ctx.inFlight.get(worldId);
  if (existing && sourceKey(existing.source) === sourceKey(source)) return existing.promise;
  if (existing) existing.controller.abort();
  const controller = new AbortController();
  const task: CheckTask = { source, controller, promise: undefined! };
  const key = sourceKey(source);
  const isCurrent = () => !ctx.closing && !controller.signal.aborted
    && ctx.inFlight.get(worldId) === task && sameSource(ctx.worlds.get(worldId), source);
  ctx.lastChecks.set(key, { lastAttemptAt: Date.now(), errorCode: null });
  task.promise = track(ctx, worldId, controller, Promise.resolve().then(async () => {
    try {
      const previous = await readIndex(ctx, source);
      assertActive(ctx, controller.signal);
      const text = await ctx.downloads.getIndex(source.updateUrl, controller.signal);
      parseReleaseIndex(text, source.packageId, previous.index);
      if (!isCurrent()) throw new AppError('WORLD_UPDATE_CANCELLED');
      const saved = await ctx.worlds.saveReleaseIndex(worldId, { ...source, text }, isCurrent);
      if (!saved || !isCurrent()) throw new AppError('WORLD_UPDATE_CANCELLED');
      ctx.lastChecks.set(key, { lastAttemptAt: ctx.lastChecks.get(key)!.lastAttemptAt, errorCode: null });
      ctx.inFlight.delete(worldId);
      return await getWorldVersions(ctx, worldId);
    } catch (error) {
      if (isCurrent()) {
        ctx.lastChecks.set(key, {
          lastAttemptAt: ctx.lastChecks.get(key)!.lastAttemptAt,
          errorCode: error instanceof AppError ? error.code : 'WORLD_DOWNLOAD_FAILED',
        });
      }
      if (error instanceof AppError) throw error;
      throw new AppError('WORLD_DOWNLOAD_FAILED');
    } finally {
      if (ctx.inFlight.get(worldId) === task) ctx.inFlight.delete(worldId);
    }
  }));
  ctx.inFlight.set(worldId, task);
  return task.promise;
}
