import { readCharacterSpriteOutput } from '../../../../modules/sessions/service.js';
import { record, serializeNoteJson } from './serialization.js';
import type { ModelNoteSource } from './types.js';

const empty = '<character_sprite></character_sprite>';

export const characterSpriteNotes: ModelNoteSource = {
  source: 'character-sprite',
  build(entry) {
    if (entry.type !== 'message' || entry.role !== 'assistant') return undefined;
    try {
      const result = readCharacterSpriteOutput(record(entry.extData.output)?.characterSprite);
      if (!result || (result.status !== 'success' && result.status !== 'partial_success') || !result.items.length) return empty;
      const rows = result.items.map(({ position, characterId, spriteId }) => serializeNoteJson({ position, characterId, spriteId }));
      return '<character_sprite>\n' + rows.join('\n') + '\n</character_sprite>';
    } catch {
      // A source-level failure must still teach the required empty-block format.
      return empty;
    }
  },
};
