import type { WorldDownload, WorldService } from '../modules/worlds/service.js';

export type ExportWorld = (worldId: string, signal?: AbortSignal) => Promise<WorldDownload>;

/** Snapshot the current definition and tags; the original upload is never an export source. */
export function createExportWorld({ worlds }: {
  worlds: Pick<WorldService, 'require' | 'buildExport'>;
}): ExportWorld {
  return async (worldId, signal) => {
    const world = worlds.require(worldId);
    return worlds.buildExport(world, signal);
  };
}
