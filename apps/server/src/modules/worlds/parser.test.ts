import { describe, expect, it } from 'vitest';
import { cardToWorld, parseCard } from './parser.js';
import { worldCardFixture } from './test-fixtures.js';

describe('world card protocol', () => {
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
