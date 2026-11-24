import { resolvePostprocessPrompts, type NarrativePresetConfig } from '../../modules/presets/service.js';
import type { CharacterSpriteCatalogItem } from '../../modules/worlds/service.js';
import type { NarrativeMaterials } from './stages/materials/index.js';

export type ContextCapabilities = { worldState: boolean; actionSuggestions: boolean; characterSprite: boolean };

export function promptSpriteCatalog(config: NarrativePresetConfig, catalog: readonly CharacterSpriteCatalogItem[]): readonly CharacterSpriteCatalogItem[] {
  return resolvePostprocessPrompts(config).characterSprite === undefined ? [] : catalog;
}

/** Apply the same declared-node and material conditions to prompt and history sources. */
export function resolveContextCapabilities(
  config: NarrativePresetConfig, materials: NarrativeMaterials, catalog: readonly CharacterSpriteCatalogItem[],
): ContextCapabilities {
  const prompts = resolvePostprocessPrompts(config);
  const hasState = materials.activeRoots.length > 0 ||
    materials.variables['state.global'].value.length > 0 || materials.variables['state.session'].value.length > 0;
  return {
    worldState: prompts.worldState !== undefined && hasState,
    actionSuggestions: prompts.actionSuggestions !== undefined,
    characterSprite: prompts.characterSprite !== undefined && catalog.length > 0,
  };
}
