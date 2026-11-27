import { worldPublication } from '../../testing/fixtures.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../infrastructure/database/connection.js';
import { createServices } from '../../services.js';
import { narrativePreset } from '../../testing/fixtures.js';
import type { WorldService, WorldPatch } from './service.js';

let db: DatabaseSync;
let worlds: WorldService;
let services: ReturnType<typeof createServices>;
let dataRoot: string;
const content = () => ({
  specVersion: '0.2', publication: worldPublication(), name: '雾港',
  characters: [{ id: 'player', name: '旅人', player_selectable: true }],
  openings: [{ id: 'start', name: '抵达', content: '船靠岸了。' }],
});

beforeEach(async () => {
  db = openDatabase(':memory:');
  dataRoot = await mkdtemp(join(tmpdir(), 'sr-v2-world-service-'));
  services = createServices(db, dataRoot);
  services.settings.ensure({ defaultPresetId: null, defaultApiModelConfigId: null });
  worlds = services.worlds;
});
afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await rm(dataRoot, { recursive: true, force: true });
});

function preset(id: string) {
  return services.presets.create({ ...narrativePreset(id), id });
}
function model() {
  return services.models.create({ id: 'model', name: 'Model', providerId: 'provider', modelId: 'model-id', credentialRef: 'credential-ref' });
}

describe('world definitions and tags', () => {
  it('reads the complete ordered sprite catalog without prompts, load rules or preset gating', () => {
    const sprites = [
      { id: 'smile', asset: 'https://images.example/alice/smile.webp', description: '微笑' },
      { id: 'default', asset: 'https://images.example/alice/default.webp', description: '平静' },
    ];
    const original = worlds.create({ ...content(), id: 'sprite-world', characters: [
      { id: 'alice', name: 'Alice', content: 'private narrative prompt', load: { mode: 'never' }, sprites },
      { id: 'player', name: 'Player', player_selectable: true },
      { id: 'bob', name: 'Bob', sprites: [{ id: 'default', asset: 'https://images.example/bob.webp', description: '严肃' }] },
    ] });
    expect(worlds.require(original.id).characters).toEqual(original.characters);
    expect(worlds.getCharacterSpriteCatalog(original.id)).toEqual({
      worldId: original.id,
      items: [
        { characterId: 'alice', characterName: 'Alice', spriteId: 'smile', description: '微笑', asset: sprites[0]!.asset },
        { characterId: 'alice', characterName: 'Alice', spriteId: 'default', description: '平静', asset: sprites[1]!.asset },
        { characterId: 'bob', characterName: 'Bob', spriteId: 'default', description: '严肃', asset: 'https://images.example/bob.webp' },
      ],
    });
    const empty = worlds.create({ ...content(), id: 'empty-world' });
    expect(worlds.getCharacterSpriteCatalog(empty.id)).toEqual({ worldId: empty.id, items: [] });
    expect(() => worlds.getCharacterSpriteCatalog('missing')).toThrow('WORLD_NOT_FOUND');
    expect(() => worlds.update(original.id, { characters: [
      { id: 'player', name: 'Player', player_selectable: true, sprites: [{ ...sprites[0] }] },
    ] })).toThrow('INVALID_WORLD_CARD');
    expect(worlds.require(original.id).characters).toEqual(original.characters);
  });

  it('persists the approved fields and ordered, deduplicated tag bindings', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const created = worlds.create({
      ...content(), tags: [' 悬疑 ', '城市', '悬疑'], state: { weather: 'rain' },
      stateDefinition: { schema_version: 2, scopes: {} },
      extensions: { author: 'test' },
    });
    expect(created.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(created.tags).toEqual(['悬疑', '城市']);
    expect(created.state).toEqual({ weather: 'rain' });
    expect(created.extensions).toEqual({ author: 'test' });
    expect(created.createdAt).toBe(1000);
    expect(created).not.toHaveProperty('spec');
    expect(created).not.toHaveProperty('source_file_path');
    expect(worlds.get(created.id)).toEqual(created);
    expect(worlds.get('missing')).toBeNull();
    expect(worlds.listTags()).toEqual([{ name: '城市', worldCount: 1 }, { name: '悬疑', worldCount: 1 }]);
  });

  it('persists component and Markdown presentations with no legacy string fallback', () => {
    const component = { type: 'component' as const, component: 'world-introduction' };
    const world = worlds.create({
      ...content(), id: 'presentation', presentation: component,
      characters: [{ id: 'player', name: '旅人', player_selectable: true, content: 'Model-only character facts',
        presentation: { type: 'markdown', text: 'Public character introduction' } }],
      components: [{ id: 'world-introduction', component: 'export default function Intro(){ return null; }' }],
      openings: [{ id: 'start', name: '抵达', content: 'Begin', presentation: component }],
    });
    expect(world.presentation).toEqual(component);
    expect(world.characters[0]).toMatchObject({ content: 'Model-only character facts',
      presentation: { type: 'markdown', text: 'Public character introduction' } });
    expect(world.openings[0]).toMatchObject({ content: 'Begin', presentation: component });
    expect(world).not.toHaveProperty('description');
    expect(world).not.toHaveProperty('characters_json');
    expect(world).not.toHaveProperty('spec_version');
    const markdown = { type: 'markdown' as const, text: 'Public world introduction' };
    expect(worlds.update(world.id, { presentation: markdown })?.presentation).toEqual(markdown);
    expect(worlds.require(world.id).presentation).toEqual(markdown);
    expect(() => worlds.update(world.id, { presentation: 'legacy prose' } as unknown as WorldPatch))
      .toThrow('INVALID_WORLD_CARD');
    expect(() => db.prepare('UPDATE worlds SET presentation_json=? WHERE id=?').run('plain prose', world.id)).toThrow();
    expect(() => worlds.update(world.id, { presentation: { type: 'component', component: '' } }))
      .toThrow('INVALID_WORLD_CARD');
    expect(worlds.require(world.id).presentation).toEqual(markdown);
  });

  it('validates every presentation reference and changed opening before committing a world patch', () => {
    const world = worlds.create({ ...content(), components: [{ id: 'intro', component: 'export default ()=>null' }],
      presentation: { type: 'component', component: 'intro' } });
    for (const patch of [
      { presentation: { type: 'component', component: 'missing' } },
      { characters: [{ id: 'player', name: '旅人', player_selectable: true, presentation: { type: 'component', component: 'missing' } }] },
      { openings: [{ id: 'start', name: 'Start', content: 'Begin', presentation: { type: 'component', component: 'missing' } }] },
      { openings: [{ id: 'start', name: 'Start', content: 'Begin', type: 'component', component: 'intro' }] },
      { components: [] },
    ] as WorldPatch[]) {
      expect(() => worlds.update(world.id, patch)).toThrow('INVALID_WORLD_CARD');
      expect(worlds.require(world.id)).toEqual(world);
    }
  });

  it('updates content and tags atomically without overwriting runtime state', () => {
    const time = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const original = worlds.create({ ...content(), tags: ['old'], state: { coins: 1 } });
    worlds.setState(original.id, { coins: 99 });
    expect(worlds.getState(original.id)).toEqual({ coins: 99 });
    time.mockReturnValue(2000);
    const coins = { type: 'number', initial: 0, description: '余额' };
    expect(() => worlds.update(original.id, { tags: ['invalid'], stateDefinition: {
      schema_version: 2, scopes: { global: { coins: { ...coins, rules: { coins: 123 } } } },
    } })).toThrow('INVALID_WORLD_CARD');
    expect(worlds.require(original.id).tags).toEqual(['old']);
    const updated = worlds.update(original.id, { name: '新雾港', tags: ['new'], stateDefinition: {
      schema_version: 2, scopes: { global: { coins } },
    } })!;
    expect(updated.name).toBe('新雾港');
    expect(updated.tags).toEqual(['new']);
    expect(updated.state).toEqual({ coins: 99 });
    expect(updated.updatedAt).toBe(2000);
    expect(updated.createdAt).toBe(1000);
    expect(() => worlds.update(original.id, { state: {} } as unknown as WorldPatch)).toThrow('INVALID_WORLD_FIELD: state');
    expect(worlds.update('missing', { name: 'unused' })).toBeNull();
  });

  it('validates references through services before changing world content or tags', () => {
    preset('story');
    model();
    const world = worlds.create({ ...content(), tags: ['keep'], defaultPresetId: 'story', defaultApiModelConfigId: 'model' });
    expect(() => worlds.update(world.id, { name: 'lost', tags: ['lost'], defaultPresetId: 'missing' })).toThrow('PRESET_NOT_FOUND');
    expect(() => worlds.update(world.id, { name: 'lost', tags: ['lost'], defaultApiModelConfigId: 'missing' })).toThrow();
    expect(worlds.get(world.id)).toEqual(world);
    expect(() => worlds.create({ ...content(), id: 'failed', defaultPresetId: 'missing', tags: ['orphan'] })).toThrow('PRESET_NOT_FOUND');
    expect(worlds.get('failed')).toBeNull();
    expect(worlds.listTags()).toEqual([{ name: 'keep', worldCount: 1 }]);
  });

  it('lists by current tag bindings and removes tags only when their world is deleted', async () => {
    const first = worlds.create({ ...content(), id: 'first', tags: ['shared', 'only-first'] });
    const second = worlds.create({ ...content(), id: 'second', tags: ['shared'] });
    expect(new Set(worlds.list({ tag: 'shared' }).map(world => world.id))).toEqual(new Set([first.id, second.id]));
    expect(worlds.list({ tag: 'only-first' }).map(world => world.id)).toEqual([first.id]);
    expect(worlds.listTags().find(tag => tag.name === 'shared')?.worldCount).toBe(2);
    expect(await worlds.delete(first.id)).toBe(true);
    expect(await worlds.delete(first.id)).toBe(false);
    expect(worlds.listTags()).toEqual([{ name: 'shared', worldCount: 1 }]);
    expect(() => worlds.update(second.id, { tags: null as never })).toThrow('INVALID_WORLD_TAGS');
    expect(worlds.get(second.id)?.tags).toEqual(['shared']);
    worlds.update(second.id, { tags: [] });
    expect(worlds.listTags()).toEqual([]);
    expect(() => worlds.list({ limit: 0 })).toThrow('INVALID_WORLD_PAGINATION');
  });

  it('preserves a world and its tags while a session refers to it', async () => {
    preset('story');
    model();
    const world = worlds.create({ ...content(), tags: ['bound'] });
    services.sessions.create({
      id: 'session', worldId: world.id, runtimeConfig: { narrativePresetId: 'story', apiModelConfigId: 'model' }, userCharacterId: 'player',
    });
    await expect(worlds.delete(world.id)).rejects.toThrow();
    expect(worlds.get(world.id)?.tags).toEqual(['bound']);
  });

  it('does not save originals for missing worlds or recreate a directory after deletion', async () => {
    await expect(worlds.saveOriginal('missing', 'json', Buffer.from('{}'))).rejects.toThrow('WORLD_NOT_FOUND');
    const world = worlds.create({ ...content(), id: 'deleting' });
    const first = worlds.saveOriginal(world.id, 'json', Buffer.from('first'));
    const second = worlds.saveOriginal(world.id, 'json', Buffer.from('second'));
    const deletion = worlds.delete(world.id);
    await expect(worlds.saveOriginal(world.id, 'json', Buffer.from('too late'))).rejects.toThrow('WORLD_NOT_FOUND');
    await Promise.all([first, second]);
    expect(await deletion).toBe(true);
    expect(await worlds.readOriginal(world.id)).toBeNull();
    expect(await worlds.delete(world.id)).toBe(false);
    await expect(worlds.delete('../outside')).rejects.toThrow('INVALID_WORLD_ID');
  });

  it('rejects unsafe IDs, removed metadata and lossy JSON before persistence', () => {
    expect(() => worlds.create({ ...content(), id: '../outside' })).toThrow('INVALID_WORLD_ID');
    expect(() => worlds.create({ ...content(), id: 'UPPERCASE' })).toThrow('INVALID_WORLD_ID');
    expect(() => worlds.create({ ...content(), spec: 'world_card' } as unknown as Parameters<WorldService['create']>[0])).toThrow('INVALID_WORLD_FIELD: spec');
    expect(() => worlds.create({ ...content(), characters: [NaN] })).toThrow('INVALID_WORLD_CARD');
    expect(() => worlds.create({ ...content(), tags: [''] })).toThrow('INVALID_WORLD_FIELD: tags');
    expect(worlds.list()).toEqual([]);
  });
});
