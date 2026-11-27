import type { ReleaseIndexSnapshot, World } from '../../modules/worlds/service.js';
import { sourceKey, sourceOf, type WorldUpdatesContext } from './context.js';
import { parseReleaseIndex } from './protocol.js';
import type { WorldUpdateSource, WorldVersionIndex, WorldVersionSummary, WorldVersions } from './types.js';

export async function readIndex(ctx: WorldUpdatesContext, source: WorldUpdateSource): Promise<{
  snapshot: ReleaseIndexSnapshot | null; index: WorldVersionIndex | null;
}> {
  try {
    const snapshot = await ctx.worlds.readReleaseIndex(source.worldId);
    return { snapshot, index: snapshot ? parseReleaseIndex(snapshot.text, source.packageId) : null };
  } catch {
    // A damaged/missing cache never becomes a persisted check failure or blocks the installed world.
    return { snapshot: null, index: null };
  }
}

function checkState(ctx: WorldUpdatesContext, source: WorldUpdateSource, hasIndex: boolean) {
  const attempt = ctx.lastChecks.get(sourceKey(source));
  const task = ctx.inFlight.get(source.worldId);
  const updateStatus = task && sourceKey(task.source) === sourceKey(source) ? 'checking'
    : attempt?.errorCode ? 'failed' : hasIndex ? 'ready' : 'not_checked';
  return { updateStatus, lastAttemptAt: attempt?.lastAttemptAt ?? null, errorCode: attempt?.errorCode ?? null } as const;
}

/** Reuse an existing list/detail projection instead of loading whole worlds or building version DTOs. */
export async function getWorldSummary(ctx: WorldUpdatesContext, world: Pick<World, 'id' | 'publication'>): Promise<WorldVersionSummary> {
  const source = sourceOf(world);
  const currentVersion = world.publication.release.version;
  if (!source) return { currentVersion, latestVersion: null, updateStatus: 'no_source' };
  const cached = await readIndex(ctx, source);
  return { currentVersion, latestVersion: cached.index?.versions[0]?.version ?? null,
    updateStatus: checkState(ctx, source, cached.index !== null).updateStatus };
}

/** Reads only the local file and per-application attempt state; never starts a request. */
export async function getWorldVersions(ctx: WorldUpdatesContext, worldId: string): Promise<WorldVersions> {
  const source = sourceOf(ctx.worlds.require(worldId));
  const cached = source ? await readIndex(ctx, source) : { snapshot: null, index: null };
  const world = ctx.worlds.require(worldId);
  const current = sourceOf(world);
  const result: WorldVersions = {
    worldId, currentVersion: world.publication.release.version, latestVersion: null,
    updateStatus: current ? 'not_checked' : 'no_source', lastSuccessAt: null, lastAttemptAt: null, errorCode: null, versions: [],
  };
  if (!current || !source || sourceKey(current) !== sourceKey(source)) return result;
  Object.assign(result, checkState(ctx, source, cached.index !== null));
  if (cached.index) {
    result.versions = cached.index.versions.map(release => ({ ...release, supported: release.spec_version === '0.2' }));
    result.latestVersion = cached.index.versions[0]?.version ?? null;
    result.lastSuccessAt = cached.snapshot!.mtimeMs;
  }
  return result;
}
