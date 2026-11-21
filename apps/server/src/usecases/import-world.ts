import { AppError } from '../errors.js';
import type { SettingsReader } from '../modules/settings/service.js';
import type { World, WorldImportInput, WorldService } from '../modules/worlds/service.js';

export type ImportWorld = (input: WorldImportInput) => Promise<World>;
type ImportWorldServices = {
  worlds: Pick<WorldService, 'prepareImport' | 'publishImport' | 'create' | 'discardImport' | 'finishImport' | 'delete'>;
  settings: SettingsReader;
};

/** Publish prepared files before the short world+tags write; failures compensate only this import. */
export function createImportWorld({ worlds, settings }: ImportWorldServices): ImportWorld {
  return async input => {
    const stage = await worlds.prepareImport(input);
    let created: World | undefined;
    try {
      const defaults = settings.get();
      await worlds.publishImport(stage);
      const world = worlds.create({
        ...stage.content, id: stage.id,
        defaultPresetId: defaults.defaultPresetId,
        defaultApiModelConfigId: defaults.defaultApiModelConfigId,
      });
      created = world;
      worlds.finishImport(stage);
      return world;
    } catch (error) {
      try {
        if (created) await worlds.delete(created.id);
        await worlds.discardImport(stage);
      } catch { throw new AppError('WORLD_IMPORT_CLEANUP_FAILED'); }
      throw error;
    }
  };
}
