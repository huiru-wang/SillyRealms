import { describe, expect, it } from 'vitest';
import {
  storedNarrativeOutputSchema, narrativeOutputSchema, parseCharacterSpriteItem, readCharacterSpriteOutput, type CharacterSpriteOutput,
} from './output.js';

const item = { position: 'left' as const, characterId: 'alice', spriteId: 'default', asset: 'alice.webp' };
const baseOutput = {
  stateUpdate: { status: 'no_updates' as const, updates: [] },
  actionSuggestions: { status: 'no_suggestions' as const, items: [] },
};

describe('persisted character sprite output', () => {
  it('keeps absent, explicit empty, partial and failed results distinct', () => {
    expect(narrativeOutputSchema.parse(baseOutput)).not.toHaveProperty('characterSprite');
    const outputs: CharacterSpriteOutput[] = [
      { status: 'success', items: [] },
      { status: 'success', items: [item] },
      { status: 'partial_success', items: [item], errors: [{ line: 2, errorCode: 'invalid_json' }] },
      { status: 'invalid_items', items: [], errors: [{ line: 1, errorCode: 'unknown_character' }] },
      { status: 'invalid_tag', items: [], errors: [{ errorCode: 'invalid_tag' }] },
      { status: 'processing_error', items: [], errors: [{ errorCode: 'processing_error' }] },
    ];
    for (const characterSprite of outputs) {
      expect(narrativeOutputSchema.parse({ ...baseOutput, characterSprite }).characterSprite).toEqual(characterSprite);
      expect(storedNarrativeOutputSchema.parse({ ...baseOutput, characterSprite })).toEqual({ ...baseOutput, characterSprite });
    }
  });

  it.each([
    { status: 'success', items: [item, { ...item, position: 'right' }] },
    { status: 'success', items: [item, { ...item, characterId: 'bob' }] },
    { status: 'success', items: [item], errors: [{ line: 2, errorCode: 'invalid_json' }] },
    { status: 'partial_success', items: [], errors: [{ line: 2, errorCode: 'invalid_json' }] },
    { status: 'partial_success', items: [item] },
    { status: 'partial_success', items: [item], errors: [{ errorCode: 'invalid_json' }] },
    { status: 'invalid_items', items: [item], errors: [{ line: 2, errorCode: 'invalid_json' }] },
    { status: 'invalid_items', items: [], errors: [{ errorCode: 'invalid_json' }] },
    { status: 'invalid_tag', items: [] },
    { status: 'processing_error', items: [item], errors: [{ errorCode: 'processing_error' }] },
    { status: 'success', items: [{ ...item, position: 'bottom' }] },
    { status: 'success', items: [{ ...item, spriteId: '' }] },
    { status: 'partial_success', items: [item], errors: [{ line: 0, errorCode: 'invalid_json' }] },
  ])('rejects impossible snapshot shape rather than treating it as successful clearing: %j', characterSprite => {
    expect(readCharacterSpriteOutput(characterSprite)).toBeNull();
    expect(narrativeOutputSchema.safeParse({ ...baseOutput, characterSprite }).success).toBe(false);
  });

  it('projects a damaged stored record as a failure while keeping absent output absent', () => {
    const damaged = { ...baseOutput, characterSprite: { status: 'success', items: [item, item] } };
    const original = structuredClone(damaged);
    expect(storedNarrativeOutputSchema.parse(damaged)).toEqual({
      ...baseOutput,
      characterSprite: {
        status: 'processing_error', items: [],
        errors: [{ errorCode: 'CHARACTER_SPRITE_STORED_RESULT_INVALID' }],
      },
    });
    expect(damaged).toEqual(original);
    expect(storedNarrativeOutputSchema.parse(baseOutput)).not.toHaveProperty('characterSprite');
  });

  it('validates stored structure without consulting changing world catalogs', () => {
    const result = { status: 'success', items: [{ ...item, characterId: 'removed-character', spriteId: 'removed-sprite' }] };
    expect(readCharacterSpriteOutput(result)).toEqual(result);
  });

  it('exposes strict three-field parsing while preserving exact identifier bytes', () => {
    const item = {position:'left',characterId:'alice',spriteId:'default'};
    expect(parseCharacterSpriteItem(item)).toEqual({ ok: true, item });
    expect(parseCharacterSpriteItem({ ...item, position: 'bottom' })).toEqual({ ok: false, errorCode: 'invalid_position' });
    expect(parseCharacterSpriteItem({ ...item, extra: true })).toEqual({ ok: false, errorCode: 'invalid_item' });
    expect(parseCharacterSpriteItem({ ...item, characterId: ' alice ' })).toEqual({
      ok: true, item: { ...item, characterId: ' alice ' },
    });
  });
});
