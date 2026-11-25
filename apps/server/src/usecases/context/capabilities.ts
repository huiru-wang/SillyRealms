import { characterSpriteAvailable, resolvePostprocessPrompts, type PostprocessPrompts, type NarrativePresetConfig } from '../../modules/presets/service.js';
import type { CharacterSpriteCatalogItem } from '../../modules/worlds/service.js';
import type { NarrativeMaterials } from './stages/materials/index.js';

export type ContextCapabilities = {
  worldState: boolean;
  stateUpdate: boolean;
  stateUpdateNotes: boolean;
  actionSuggestions: boolean;
  characterSprite: boolean;
};

export function promptSpriteCatalog(config: NarrativePresetConfig, catalog: readonly CharacterSpriteCatalogItem[]): readonly CharacterSpriteCatalogItem[] {
  return resolvePostprocessPrompts(config).characterSprite === undefined ? [] : catalog;
}

/** Past updates remain useful with read-only facts; a new update also requires message roots. */
export function resolveContextCapabilities(
  prompts: PostprocessPrompts, materials: NarrativeMaterials, catalog: readonly CharacterSpriteCatalogItem[],
): ContextCapabilities {
  const hasState = Object.values(materials.visibleRoots).some(roots => roots.size > 0);
  return {
    worldState: hasState,
    stateUpdateNotes: prompts.stateUpdate !== undefined && hasState,
    stateUpdate: prompts.stateUpdate !== undefined && materials.activeRoots.length > 0,
    actionSuggestions: prompts.actionSuggestions !== undefined,
    characterSprite: characterSpriteAvailable(prompts, catalog.length),
  };
}
