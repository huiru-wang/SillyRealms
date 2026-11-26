import { AppError } from '../../errors.js';
import type { World } from '../../modules/worlds/service.js';
import { applyWorldVersion } from './apply.js';
import { refreshWorldVersions } from './check.js';
import { sourceKey, type WorldUpdatesContext, type WorldUpdatesDependencies } from './context.js';
import { worldUpdateDownloads } from './downloads.js';
import { getWorldVersions, getWorldSummary } from './read.js';
import type { ApplyWorldVersionInput, WorldVersionSummary } from './types.js';

export { validateReleaseIndex, releaseIndexLimits } from './protocol.js';
export type { WorldReleaseRecord, WorldVersionIndex, WorldVersionSummary, WorldVersions, WorldUpdateStatus, ApplyWorldVersionInput } from './types.js';
export type { WorldUpdateDownloads } from './downloads.js';
export type { WorldUpdatesDependencies } from './context.js';

/** One instance per application, shared by HTTP, startup, deletion, and shutdown. */
export function createWorldUpdates(dependencies: WorldUpdatesDependencies) {
  const ctx: WorldUpdatesContext = {
    ...dependencies, downloads: dependencies.downloads ?? worldUpdateDownloads,
    inFlight: new Map(), lastChecks: new Map(), operations: new Set(), closing: false,
  };
  let startup: Promise<void> | undefined;
  let shutdown: Promise<void> | undefined;
  return {
    getVersions: (worldId: string) => getWorldVersions(ctx, worldId),
    async getSummaries(worlds: readonly Pick<World, 'id' | 'publication'>[]): Promise<Record<string, WorldVersionSummary>> {
      const unique = new Map(worlds.map(world => [world.id, world]));
      const entries = await Promise.all([...unique.values()].map(async world => [world.id, await getWorldSummary(ctx, world)] as const));
      return Object.fromEntries(entries);
    },
    refresh: (worldId: string) => refreshWorldVersions(ctx, worldId),
    applyVersion: (worldId: string, input: ApplyWorldVersionInput) => applyWorldVersion(ctx, worldId, input),
    checkAtStartup(): Promise<void> {
      if (startup) return startup;
      if (ctx.closing) return Promise.reject(new AppError('WORLD_UPDATE_CANCELLED'));
      const sources = ctx.worlds.listUpdateSources();
      let next = 0;
      startup = Promise.all(Array.from({ length: Math.min(3, sources.length) }, async () => {
        while (!ctx.closing && next < sources.length) {
          const source = sources[next++]!;
          try { await refreshWorldVersions(ctx, source.worldId); }
          catch { /* Per-world status retains the failure; startup never blocks other worlds. */ }
        }
      })).then(() => {});
      return startup;
    },
    cancelForWorld(worldId: string): void {
      const task = ctx.inFlight.get(worldId);
      if (task) { task.controller.abort(); ctx.inFlight.delete(worldId); }
      for (const operation of ctx.operations) if (operation.worldId === worldId) operation.controller.abort();
      for (const key of ctx.lastChecks.keys()) {
        if ((JSON.parse(key) as string[])[0] === worldId) ctx.lastChecks.delete(key);
      }
    },
    shutdown(): Promise<void> {
      if (shutdown) return shutdown;
      ctx.closing = true;
      for (const operation of ctx.operations) operation.controller.abort();
      for (const task of ctx.inFlight.values()) ctx.lastChecks.delete(sourceKey(task.source));
      ctx.inFlight.clear();
      shutdown = Promise.allSettled([...ctx.operations].map(operation => operation.promise)).then(() => {});
      return shutdown;
    },
  };
}
export type WorldUpdates = ReturnType<typeof createWorldUpdates>;
