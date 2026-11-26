import { AppError } from '../../errors.js';
import type { RuntimeCache } from '../../infrastructure/cache/index.js';
import type { EventHub } from '../../infrastructure/events/event-hub.js';
import type { SessionService } from '../../modules/sessions/service.js';
import type { World, WorldService } from '../../modules/worlds/service.js';
import type { WorldUpdateDownloads } from './downloads.js';
import type { CheckRecord, CheckTask, WorldUpdateSource } from './types.js';

export type WorldUpdatesDependencies = {
  worlds: Pick<WorldService, 'get' | 'require' | 'readReleaseIndex' | 'saveReleaseIndex' | 'listUpdateSources' | 'prepareImport' | 'discardImport' | 'applyPreparedReplacement'>;
  sessions: Pick<SessionService, 'listIdsByWorld' | 'require'>;
  cache: RuntimeCache;
  events: Pick<EventHub, 'publish'>;
  downloads?: WorldUpdateDownloads;
};
export type Operation = { worldId: string; controller: AbortController; promise: Promise<unknown> };
export type WorldUpdatesContext = Omit<WorldUpdatesDependencies, 'downloads'> & {
  downloads: WorldUpdateDownloads;
  inFlight: Map<string, CheckTask>;
  lastChecks: Map<string, CheckRecord>;
  operations: Set<Operation>;
  closing: boolean;
};

export function sourceOf(world: Pick<World, 'id' | 'publication'>): WorldUpdateSource | null {
  const publication = world.publication;
  return publication?.update_url
    ? { worldId: world.id, packageId: publication.package_id, updateUrl: publication.update_url }
    : null;
}
export function sourceKey(source: WorldUpdateSource): string {
  return JSON.stringify([source.worldId, source.packageId, source.updateUrl]);
}
export function sameSource(world: World | null, source: WorldUpdateSource): boolean {
  const current = world && sourceOf(world);
  return current !== null && sourceKey(current) === sourceKey(source);
}
export function assertActive(ctx: WorldUpdatesContext, signal?: AbortSignal): void {
  if (ctx.closing || signal?.aborted) throw new AppError('WORLD_UPDATE_CANCELLED');
}
export function track<T>(ctx: WorldUpdatesContext, worldId: string, controller: AbortController, promise: Promise<T>): Promise<T> {
  const operation: Operation = { worldId, controller, promise };
  ctx.operations.add(operation);
  const finish = () => { ctx.operations.delete(operation); };
  void promise.then(finish, finish);
  return promise;
}
