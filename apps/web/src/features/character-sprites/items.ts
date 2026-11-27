import type {CharacterSpriteItem} from '../../../../../packages/sr-sdk/src/stage-contract.ts';
import type {Character} from '../worlds/api/worlds.ts';

export type DisplaySprite = CharacterSpriteItem & {asset?: string};

export function spriteResource(item: DisplaySprite, characters: readonly Character[]) {
  const character = characters.find(row => row.id === item.characterId);
  const asset = item.asset ?? character?.sprites?.find(sprite => sprite.id === item.spriteId)?.asset;
  return {asset, name: character?.name ?? item.characterId};
}

const positions = new Set(['left', 'right', 'center', 'top', 'topleft', 'topright', 'truecenter']);

export function isSpriteSnapshot(value: unknown): value is CharacterSpriteItem[] {
  if (!Array.isArray(value) || value.length > positions.size) return false;
  const characters = new Set<string>(), occupied = new Set<string>();
  for (const item of value) {
    if (!item || !positions.has(item.position) || typeof item.characterId !== 'string' || !item.characterId.trim() ||
      typeof item.spriteId !== 'string' || !item.spriteId.trim() || characters.has(item.characterId) || occupied.has(item.position)) return false;
    characters.add(item.characterId);
    occupied.add(item.position);
  }
  return true;
}

export function appliedItems(result: unknown): CharacterSpriteItem[] | null {
  if (!result || typeof result !== 'object' || !('items' in result) || !('status' in result) || !isSpriteSnapshot(result.items)) return null;
  if (result.status === 'success' || (result.status === 'partial_success' && result.items.length)) return result.items;
  return null;
}
