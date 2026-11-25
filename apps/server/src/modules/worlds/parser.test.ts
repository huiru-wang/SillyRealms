import { describe, expect, it } from 'vitest';
import { cardToWorld, parseCard } from './parser.js';
import { worldCardFixture } from './test-fixtures.js';

describe('world card protocol', () => {
  it.each([true, false])('preserves an explicit cover mosaic flag (%s) and all author extensions', enabled => {
    const raw = worldCardFixture();
    const extensions = { cover_mosaic_enabled: enabled, author: { version: '1.0', notes: ['keep', 2, false] } };
    const card = parseCard({ ...raw, data: { ...raw.data, extensions } });
    expect(card.data.extensions).toEqual(extensions);
    expect(cardToWorld(card).extensions).toEqual(extensions);
    expect(parseCard(raw).data).not.toHaveProperty('extensions');
  });

  it('requires an extension object and a boolean for the reserved cover flag', () => {
    const raw = worldCardFixture();
    for (const extensions of [null, [], 'text', 1]) {
      expect(() => parseCard({ ...raw, data: { ...raw.data, extensions } })).toThrow('$.data.extensions');
    }
    for (const enabled of [null, 'true', 'false', 0, 1, [], {}]) {
      expect(() => parseCard({ ...raw, data: { ...raw.data, extensions: { cover_mosaic_enabled: enabled } } }))
        .toThrow('$.data.extensions.cover_mosaic_enabled');
    }
  });

  it('preserves optional sprite metadata and permits the same sprite ID in different characters', () => {
    const raw = worldCardFixture();
    const sprites = [
      { id: 'default', asset: 'https://images.example/alice/default.webp', description: '平静站立' },
      { id: 'smile', asset: 'sr-asset://assets/alice/smile.webp', description: '微笑' },
    ];
    const card = parseCard({ ...raw, data: { ...raw.data, characters: [
      { ...raw.data.characters[0], sprites },
      { id: 'bob', name: 'Bob', sprites: [{ ...sprites[0], asset: 'http://images.example/bob.webp' }] },
      { id: 'carol', name: 'Carol', sprites: [] },
      { id: 'dave', name: 'Dave' },
    ] } });
    expect(card.data.characters[0]?.sprites).toEqual(sprites);
    expect(cardToWorld(card).characters).toEqual(card.data.characters);
    expect(card.data.characters[2]?.sprites).toEqual([]);
    expect(card.data.characters[3]).not.toHaveProperty('sprites');
  });

  it('rejects invalid sprite declarations at their character field', () => {
    const raw = worldCardFixture();
    const sprite = { id: 'default', asset: 'https://images.example/alice.webp', description: '平静' };
    const invalid = [
      [{ ...sprite, id: 'smile' }],
      [sprite, { ...sprite }],
      [{ ...sprite, id: ' ' }],
      [{ ...sprite, description: ' ' }],
      [{ ...sprite, asset: '' }],
      [{ ...sprite, asset: 'file:///private/picture.webp' }],
      [{ ...sprite, asset: 'data:image/png;base64,AQ==' }],
      [{ ...sprite, asset: 'assets/picture.webp' }],
      [{ ...sprite, asset: 'sr-asset://components/picture.webp' }],
      [{ ...sprite, asset: 'sr-asset://assets/../secret' }],
      [{ ...sprite, asset: 'https://' }],
      [{ ...sprite, position: 'left' }],
      null,
    ];
    for (const sprites of invalid) {
      expect(() => parseCard({ ...raw, data: { ...raw.data,
        characters: [{ ...raw.data.characters[0], sprites }],
      } })).toThrow('$.data.characters[0].sprites');
    }
  });

  it('accepts optional and partial rule maps and rejects malformed entries at import', () => {
    const raw = worldCardFixture();
    const parse = (fields: object) => parseCard({ ...raw, data: { ...raw.data,
      state: { schema_version: 2, scopes: { message: { bag: {
        type: 'json', initial: { items: [], gold: 5 }, description: 'Bag', ...fields,
      } } } },
      openings: [{ ...raw.data.openings[0], initial_state: { bag: { items: [{ extra: 1 }] } } }],
    } });
    for (const fields of [{}, { rules: {} }, { rules: { 'bag.gold': 'Gold' } }]) {
      expect(parse(fields).data.state?.scopes.message?.bag).toMatchObject(fields);
    }
    for (const rules of [null, [], 'text', { bag: 1 }, { bag: ' ' }, { 'other.gold': 'Gold' }, { 'bag.items[0]': 'Item' }]) {
      expect(() => parse({ rules })).toThrow('INVALID_WORLD_CARD');
    }
  });

  it('accepts cards without spec, drops the retired legacy marker and preserves author keys', () => {
    const raw = worldCardFixture();
    const card = parseCard({ ...raw, spec: 'world_card' });
    expect(card).toEqual(raw);
    expect(card).not.toHaveProperty('spec');
    const content = cardToWorld(card);
    expect(content.specVersion).toBe('0.1');
    expect(content.characters).toEqual(raw.data.characters);
    expect(content.state).toEqual({ coins: 3 });
    expect(content.stateDefinition).toEqual(raw.data.state);
  });

  it('validates component references and package component paths', () => {
    const raw = worldCardFixture();
    expect(() => parseCard({ ...raw, data: { ...raw.data, stage_component: 'absent' } })).toThrow('Component not found');
    expect(() => parseCard({ ...raw, data: { ...raw.data, components: [{ id: 'intro', path: '../intro.tsx' }] } })).toThrow('INVALID_WORLD_CARD');
    expect(() => parseCard({ ...raw, data: { ...raw.data, description: 'plain text' } })).toThrow('INVALID_WORLD_CARD');
  });

  it('validates state definitions and opening values without executing when expressions', () => {
    const raw = worldCardFixture();
    expect(() => parseCard({
      ...raw, data: { ...raw.data, state: { schema_version: 2, scopes: { global: {
        coins: { type: 'number', initial: 'invalid', description: '金币', rules: { coins: '按叙事中的交易变化' } },
      } } } },
    })).toThrow('INVALID_WORLD_CARD');
    expect(() => parseCard({
      ...raw, data: { ...raw.data, characters: [{ ...raw.data.characters[0], load: { when: 'process.exit()' } }] },
    })).toThrow('Unsupported when expression');
    const poisoned = JSON.parse(JSON.stringify(raw));
    poisoned.data.openings[0].initial_state = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(() => parseCard(poisoned)).toThrow('INVALID_WORLD_CARD');
    expect(() => parseCard({
      ...raw, data: { ...raw.data, openings: [{ ...raw.data.openings[0], initial_state: { absent: 1 } }] },
    })).toThrow('State root not found');
  });
});
