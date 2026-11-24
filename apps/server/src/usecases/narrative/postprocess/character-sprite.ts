import { parseCharacterSpriteItem, type CharacterSpriteOutput, type CharacterSpriteItem } from '../../../modules/sessions/service.js';
import type { CharacterSpriteCatalogItem } from '../../../modules/worlds/service.js';
import type { CapabilityExtraction } from './parser.js';
import { parseJsonl } from './strict-json.js';

export const failedCharacterSpriteOutput = (): CharacterSpriteOutput => ({
  status: 'processing_error', items: [], errors: [{ errorCode: 'processing_error' }],
});

/** Accept independent rows into one new snapshot; rejected rows reserve neither key. */
export function processCharacterSprite(
  extraction: CapabilityExtraction,
  catalog: readonly CharacterSpriteCatalogItem[],
): CharacterSpriteOutput | undefined {
  if (extraction.status === 'missing') return undefined;
  if (extraction.status === 'invalid_tag' || extraction.blocks.length !== 1) {
    return { status: 'invalid_tag', items: [], errors: [{ errorCode: 'invalid_tag' }] };
  }
  if (extraction.status === 'empty') return { status: 'success', items: [] };

  const sprites = new Map<string, Set<string>>();
  for (const entry of catalog) {
    const choices = sprites.get(entry.characterId) ?? new Set<string>();
    choices.add(entry.spriteId);
    sprites.set(entry.characterId, choices);
  }
  const items: CharacterSpriteItem[] = [];
  const errors: NonNullable<CharacterSpriteOutput['errors']> = [];
  const characters = new Set<string>(), positions = new Set<string>();
  for (const [index, row] of parseJsonl(extraction.blocks).entries()) {
    const reject = (errorCode: string) => { errors.push({ line: index + 1, errorCode }); };
    if (!row.ok) { reject('invalid_json'); continue; }
    try {
      const parsed = parseCharacterSpriteItem(row.value);
      if (!parsed.ok) { reject(parsed.errorCode); continue; }
      const item = parsed.item;
      const choices = sprites.get(item.characterId);
      if (!choices) { reject('unknown_character'); continue; }
      if (!choices.has(item.spriteId)) { reject('unknown_sprite'); continue; }
      if (characters.has(item.characterId)) { reject('duplicate_character'); continue; }
      if (positions.has(item.position)) { reject('duplicate_position'); continue; }
      items.push(item);
      characters.add(item.characterId);
      positions.add(item.position);
    } catch {
      reject('processing_error');
    }
  }
  if (!errors.length) return { status: 'success', items };
  return { status: items.length ? 'partial_success' : 'invalid_items', items, errors };
}
