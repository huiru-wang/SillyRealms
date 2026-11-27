import { z } from 'zod';
import { isReleaseVersion } from '@sillyrealms/sdk/release-version';
import { AppError } from '../../errors.js';
import type { PreparedWorldImport, World } from '../../modules/worlds/service.js';
import { assertActive, sameSource, sourceOf, track, type WorldUpdatesContext } from './context.js';
import { parseReleaseIndex, requireRelease } from './protocol.js';
import { readIndex } from './read.js';
import type { ApplyWorldVersionInput, WorldUpdateSource } from './types.js';

const applySchema = z.object({
  version: z.string().refine(isReleaseVersion),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

function assertWorld(ctx: WorldUpdatesContext, source: WorldUpdateSource, input: ApplyWorldVersionInput): World {
  const world = ctx.worlds.require(source.worldId);
  if (!sameSource(world, source)) throw new AppError('WORLD_UPDATE_SOURCE_CHANGED');
  if (world.revision !== input.expectedRevision) throw new AppError('WORLD_REVISION_CONFLICT');
  if (world.publication.release.version === input.version) throw new AppError('WORLD_RELEASE_ALREADY_INSTALLED');
  return world;
}

/** Download and validate outside the lock; commit only after a fresh, locked preflight. */
export function applyWorldVersion(ctx: WorldUpdatesContext, worldId: string, input: ApplyWorldVersionInput): Promise<World> {
  assertActive(ctx);
  const parsed = applySchema.safeParse(input);
  if (!parsed.success) throw new AppError('INVALID_REQUEST');
  const value = parsed.data;
  const source = sourceOf(ctx.worlds.require(worldId));
  if (!source) throw new AppError('WORLD_UPDATE_NO_SOURCE');
  assertWorld(ctx, source, value);
  ctx.cache.assertWorldUpdateAvailable(worldId);
  const controller = new AbortController();
  return track(ctx, worldId, controller, (async () => {
    let stage: PreparedWorldImport | undefined;
    let installed: World;
    try {
      const cached = await readIndex(ctx, source);
      const release = requireRelease(cached.index, value.version);
      if (release.artifact.sha256 !== value.expectedSha256) throw new AppError('WORLD_UPDATE_CONFLICT');
      if (release.spec_version !== '0.2') throw new AppError('WORLD_RELEASE_UNSUPPORTED');
      assertActive(ctx, controller.signal);
      const artifact = await ctx.downloads.getArtifact(release, controller.signal);
      assertActive(ctx, controller.signal);
      stage = await ctx.worlds.prepareImport(artifact, worldId);
      assertActive(ctx, controller.signal);
      const publication = stage.content.publication;
      if (stage.content.specVersion !== release.spec_version || publication.package_id !== source.packageId
        || publication.release.version !== release.version) throw new AppError('WORLD_UPDATE_CONFLICT');
      const permit = ctx.cache.acquireWorldUpdate(worldId);
      try {
        assertWorld(ctx, source, value);
        const playerCharacterIds = ctx.sessions.listIdsByWorld(worldId).map(id => ctx.sessions.require(id).userCharacterId);
        installed = await ctx.worlds.applyPreparedReplacement(stage, {
          expectedRevision: value.expectedRevision, packageId: source.packageId, updateUrl: source.updateUrl,
          playerCharacterIds, permit,
          guard(snapshot) {
            assertActive(ctx, controller.signal);
            assertWorld(ctx, source, value);
            const latest = requireRelease(snapshot ? parseReleaseIndex(snapshot.text, source.packageId) : null, value.version);
            if (latest.artifact.sha256 !== value.expectedSha256 || latest.spec_version !== release.spec_version) {
              throw new AppError('WORLD_UPDATE_CONFLICT');
            }
          },
        });
      } finally { ctx.cache.releaseWorldUpdate(permit); }
    } finally {
      if (stage) await ctx.worlds.discardImport(stage);
    }
    const timestamp = Date.now();
    for (const sessionId of ctx.sessions.listIdsByWorld(worldId)) {
      ctx.events.publish(sessionId, { event: 'world.updated', data: {
        sessionId, worldId, version: value.version, revision: installed.revision, timestamp,
      } });
    }
    return installed;
  })());
}
