import { afterEach, describe, expect, it, vi } from 'vitest';
import * as sessionOutputs from '../../../modules/sessions/service.js';
import type { CharacterSpriteItem, CharacterSpritePosition } from '../../../modules/sessions/service.js';
import type { StateService } from '../../../modules/state/service.js';
import type { CharacterSpriteCatalogItem } from '../../../modules/worlds/service.js';
import * as sprites from './character-sprite.js';
import { extractCapability } from './parser.js';
import { processNarrativeOutput } from './processor.js';

const positions: CharacterSpritePosition[] = ['left', 'center', 'right', 'top', 'topleft', 'topright', 'truecenter'];
const characters = ['alice', 'bob', 'carol', 'dave', 'eve', 'frank', 'grace'];
const catalog: CharacterSpriteCatalogItem[] = characters.flatMap(characterId => ['default', 'smile'].map(spriteId => ({
  characterId, characterName: characterId, spriteId, description: spriteId,
  asset: 'https://example.test/' + characterId + '/' + spriteId + '.webp',
})));
const item = (characterId: string, position: CharacterSpritePosition, spriteId = 'default'): CharacterSpriteItem =>
  ({ position, characterId, spriteId });
const block = (rows: string) => '<character_sprite>\n' + rows + '\n</character_sprite>';
const parse = (text: string, list = catalog) => sprites.processCharacterSprite(extractCapability(text, 'character_sprite'), list);
const encode = (items: CharacterSpriteItem[]) => items.map(value => JSON.stringify(value)).join('\n');

afterEach(() => vi.restoreAllMocks());

describe('character sprite JSONL snapshots', () => {
  it('distinguishes missing output from an explicit empty or whitespace-only snapshot', () => {
    expect(parse('Only prose')).toBeUndefined();
    expect(parse('<character_sprite></character_sprite>', [])).toEqual({ status: 'success', items: [] });
    expect(parse(block(' \n\t\r\n'), [])).toEqual({ status: 'success', items: [] });
    expect(parse(block('[]'))).toEqual({
      status: 'invalid_items', items: [], errors: [{ line: 1, errorCode: 'invalid_item' }],
    });
  });

  it('accepts all seven distinct positions and more than two characters in original order', () => {
    const items = positions.map((position, index) => item(characters[index]!, position));
    expect(parse(block(encode(items)))).toEqual({ status: 'success', items });
  });

  it('keeps the first valid row and lets failed duplicate-position/character rows reserve neither key', () => {
    const rows = [
      item('alice', 'left'), item('bob', 'left'), item('bob', 'center'),
      item('alice', 'top'), item('carol', 'top'), item('carol', 'top'),
    ];
    expect(parse(block(encode(rows)))).toEqual({
      status: 'partial_success', items: [rows[0], rows[2], rows[4]],
      errors: [
        { line: 2, errorCode: 'duplicate_position' },
        { line: 4, errorCode: 'duplicate_character' },
        { line: 6, errorCode: 'duplicate_character' },
      ],
    });
  });

  it('does not let a rejected reference reserve either key or substitute a default sprite', () => {
    const rows = [item('alice', 'left', 'missing'), item('bob', 'left'), item('alice', 'right')];
    expect(parse(block(encode(rows)))).toEqual({
      status: 'partial_success', items: rows.slice(1), errors: [{ line: 1, errorCode: 'unknown_sprite' }],
    });
    expect(parse(block(encode([item('ALICE', 'left')])))).toMatchObject({
      status: 'invalid_items', errors: [{ line: 1, errorCode: 'unknown_character' }],
    });
  });

  it.each([
    ['invalid JSON', '{"characterId":', 'invalid_json'],
    ['duplicate JSON key', '{"position":"left","characterId":"alice","spriteId":"smile","spriteId":"default"}', 'invalid_json'],
    ['decoded duplicate key', '{"position":"left","characterId":"alice","spriteId":"smile","sprite\\u0049d":"default"}', 'invalid_json'],
    ['missing field', '{"characterId":"alice","spriteId":"default"}', 'invalid_item'],
    ['extra field', '{"position":"left","characterId":"alice","spriteId":"default","visible":true}', 'invalid_item'],
    ['blank identifier', '{"position":"left","characterId":" ","spriteId":"default"}', 'invalid_item'],
    ['wrong type', '{"position":"left","characterId":7,"spriteId":"default"}', 'invalid_item'],
    ['invalid position', '{"position":"LEFT","characterId":"alice","spriteId":"default"}', 'invalid_position'],
    ['unknown character', '{"position":"left","characterId":"missing","spriteId":"default"}', 'unknown_character'],
    ['unknown sprite', '{"position":"left","characterId":"alice","spriteId":"missing"}', 'unknown_sprite'],
  ])('skips a row with %s and continues with the next valid row', (_name, rejected, errorCode) => {
    const accepted = item('alice', 'left');
    expect(parse(block(' \n' + rejected + '\n\n' + JSON.stringify(accepted)))).toEqual({
      status: 'partial_success', items: [accepted], errors: [{ line: 1, errorCode }],
    });
  });

  it('counts nonempty data rows and retains all-invalid diagnostics without inventing a clear', () => {
    expect(parse(block('\nno json\n \t\n{}\n[]\n'))).toEqual({
      status: 'invalid_items', items: [],
      errors: [
        { line: 1, errorCode: 'invalid_json' },
        { line: 2, errorCode: 'invalid_item' },
        { line: 3, errorCode: 'invalid_item' },
      ],
    });
    expect(parse(block(encode([item('alice', 'left')])), [])).toMatchObject({
      status: 'invalid_items', items: [], errors: [{ errorCode: 'unknown_character' }],
    });
  });

  it('does not impose a two-item or raw line-count cap', () => {
    const rows = positions.map((position, index) => item(characters[index]!, position));
    const result = parse(block('invalid\n'.repeat(105) + encode(rows)));
    expect(result?.status).toBe('partial_success');
    expect(result?.items).toEqual(rows);
    expect(result?.errors).toHaveLength(105);
  });

  it('isolates an unexpected row validation error and continues without reserving its keys', () => {
    const original = sessionOutputs.parseCharacterSpriteItem;
    vi.spyOn(sessionOutputs, 'parseCharacterSpriteItem')
      .mockImplementationOnce(() => { throw new Error('row failure'); }).mockImplementation(original);
    const row = item('alice', 'left');
    expect(parse(block(encode([row, row])))).toEqual({
      status: 'partial_success', items: [row], errors: [{ line: 1, errorCode: 'processing_error' }],
    });
  });

  it.each([
    '<character_sprite>',
    '</character_sprite>',
    '<character_sprite broken></character_sprite>',
    '<character_sprite><character_sprite></character_sprite></character_sprite>',
    '<character_sprite></character_sprite><character_sprite></character_sprite>',
    block(encode([item('alice', 'left')])) + block(encode([item('bob', 'right')])),
  ])('rejects a broken or duplicate block boundary without applying any row: %s', text => {
    expect(parse(text)).toEqual({
      status: 'invalid_tag', items: [], errors: [{ errorCode: 'invalid_tag' }],
    });
  });

  it('uses case-insensitive own tags without depending on another capability boundary', () => {
    const accepted = item('alice', 'topleft');
    const text = '<state_update>broken\n<CHARACTER_SPRITE>' + JSON.stringify(accepted) + '</CHARACTER_SPRITE>';
    expect(parse(text)).toEqual({ status: 'success', items: [accepted] });
  });

  it('starts fresh for every message rather than merging previous accepted rows', () => {
    expect(parse(block(encode([item('alice', 'left'), item('bob', 'right')])))).toMatchObject({ items: expect.any(Array) });
    expect(parse(block(encode([item('carol', 'center')])))).toEqual({
      status: 'success', items: [item('carol', 'center')],
    });
  });
});

describe('independent sprite postprocess capability', () => {
  const state: Pick<StateService, 'prepareMessageUpdates'> = { prepareMessageUpdates: vi.fn() };
  const context = { sessionId: 'session', parentId: 'message', allowedRoots: [], characterSpriteCatalog: catalog };

  it('has no preset/enabled input and keeps missing output absent', () => {
    expect(processNarrativeOutput('Prose', state, context).output).not.toHaveProperty('characterSprite');
    expect(processNarrativeOutput(block(encode([item('alice', 'left')])), state, context).output.characterSprite)
      .toEqual({ status: 'success', items: [item('alice', 'left')] });
  });

  it('isolates capability failure from suggestions and reports the failed sprite result', () => {
    vi.spyOn(sprites, 'processCharacterSprite').mockImplementation(() => { throw new Error('capability failure'); });
    const observe = vi.fn();
    const result = processNarrativeOutput('<action_suggestions>["Continue."]</action_suggestions>' +
      block(encode([item('alice', 'left')])), state, context, observe);
    expect(result.output.actionSuggestions).toEqual({ status: 'success', items: ['Continue.'] });
    expect(result.output.characterSprite).toEqual({
      status: 'processing_error', items: [], errors: [{ errorCode: 'processing_error' }],
    });
    expect(observe).toHaveBeenCalledWith('character_sprite.result', {
      phase: 'prepared', status: 'processing_error', items: [], errors: [{ errorCode: 'processing_error' }],
    });
  });
});
