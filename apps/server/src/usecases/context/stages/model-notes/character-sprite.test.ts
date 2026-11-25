import { describe, expect, it } from 'vitest';
import type { CharacterSpriteOutput, SessionEntry } from '../../../../modules/sessions/service.js';
import { buildNarrativeNotes } from './index.js';

const onlySprites = { stateUpdateNotes: false, actionSuggestions: false, characterSprite: true };
const empty = '<character_sprite></character_sprite>';
function message(id: string, result?: unknown, content = '正文'): SessionEntry {
  return {
    id, sessionId: 'session', parentId: null, runId: id, seq: 1, timestamp: 1,
    type: 'message', role: 'assistant', payload: { message: { role: 'assistant', content, timestamp: 1 } },
    state: null, extData: (result === undefined ? {} : { output: { characterSprite: result } }) as SessionEntry['extData'],
    metrics: null, createdAt: 1, updatedAt: 1,
  };
}
function note(entry: SessionEntry) {
  return buildNarrativeNotes([entry], onlySprites).get(entry.id)?.[0]?.content;
}

describe('character sprite historical notes', () => {
  it('serializes the corresponding accepted partial snapshot without statuses or errors', () => {
    const result: CharacterSpriteOutput = {
      status: 'partial_success',
      items: [
        { position: 'left', characterId: 'alice', spriteId: 'smile' },
        { position: 'center', characterId: 'bob', spriteId: 'default' },
        { position: 'right', characterId: 'carol', spriteId: 'serious' },
      ],
      errors: [{ line: 2, errorCode: 'duplicate_position' }],
    };
    expect(note(message('answer', result))).toBe([
      '<character_sprite>',
      '{"position":"left","characterId":"alice","spriteId":"smile"}',
      '{"position":"center","characterId":"bob","spriteId":"default"}',
      '{"position":"right","characterId":"carol","spriteId":"serious"}',
      '</character_sprite>',
    ].join('\n'));
  });

  it.each([
    undefined,
    { status: 'success', items: [] },
    { status: 'invalid_items', items: [], errors: [{ line: 1, errorCode: 'invalid_json' }] },
    { status: 'invalid_tag', items: [], errors: [{ errorCode: 'invalid_tag' }] },
    { status: 'processing_error', items: [], errors: [{ errorCode: 'processing_error' }] },
    { status: 'success', items: [{ position: 'unknown', characterId: 'alice', spriteId: 'default' }] },
  ])('returns an explicit empty block for a missing, empty, failed or damaged result %#', result => {
    expect(note(message('answer', result))).toBe(empty);
  });

  it('keeps an empty block even if reading the stored result throws', () => {
    const entry = message('answer');
    Object.defineProperty(entry.extData, 'output', { get() { throw new Error('unreadable'); } });
    expect(note(entry)).toBe(empty);
  });

  it('rejects corrupt duplicate snapshots and never borrows another message result', () => {
    const valid = { status: 'success', items: [{ position: 'left', characterId: 'alice', spriteId: 'default' }] };
    const corrupt = { status: 'success', items: [...valid.items, { position: 'top', characterId: 'alice', spriteId: 'smile' }] };
    const entries = [message('old', valid), message('missing'), message('corrupt', corrupt)];
    const notes = buildNarrativeNotes(entries, onlySprites);
    expect([...notes.keys()]).toEqual(['missing', 'corrupt']);
    expect(notes.get('missing')?.[0]?.content).toBe(empty);
    expect(notes.get('corrupt')?.[0]?.content).toBe(empty);
    expect(entries[1]!.extData).toEqual({});
  });

  it('omits even empty blocks when disabled and leaves user and hidden messages out of the window', () => {
    expect(buildNarrativeNotes([message('answer')], { ...onlySprites, characterSprite: false }).size).toBe(0);
    const user = message('user'); user.role = 'user'; user.payload.message = { role: 'user', content: 'input', timestamp: 1 };
    expect([...buildNarrativeNotes([message('answer'), user, message('hidden', undefined, '')], onlySprites).keys()])
      .toEqual(['answer']);
  });
});
