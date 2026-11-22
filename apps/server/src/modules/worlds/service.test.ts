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
  specVersion: '0.1', name: '雾港',
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

  it('decodes component descriptions while preserving textual descriptions and author JSON keys', () => {
    const component = { type: 'component' as const, component: 'world-description' };
    const world = worlds.create({
      ...content(), id: 'description', description: component,
      characters: [{ id: 'player', name: '旅人', player_selectable: true }],
      components: [{ id: 'world-description', component: 'export default function Intro(){ return null; }' }],
      openings: [{ id: 'start', name: '抵达', content: 'Begin' }],
    });
    expect(world.description).toEqual(component);
    expect(world.characters).toEqual([{ id: 'player', name: '旅人', player_selectable: true }]);
    expect(world.openings).toEqual([{ id: 'start', name: '抵达', content: 'Begin' }]);
    expect(world).not.toHaveProperty('characters_json');
    expect(world).not.toHaveProperty('spec_version');
    const jsonText = JSON.stringify(component);
    expect(worlds.update(world.id, { description: jsonText })?.description).toBe(jsonText);
    db.prepare('UPDATE worlds SET description=? WHERE id=?').run('earlier plain text', world.id);
    expect(worlds.require(world.id).description).toBe('earlier plain text');
    db.prepare('UPDATE worlds SET description=? WHERE id=?').run(jsonText, world.id);
    expect(worlds.require(world.id).description).toEqual(component);
    expect(() => worlds.update(world.id, { description: { type: 'component', component: '' } }))
      .toThrow('INVALID_WORLD_FIELD');
    expect(worlds.require(world.id).description).toEqual(component);
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
    expect(() => worlds.setTags(second.id, undefined as never)).toThrow('INVALID_WORLD_TAGS');
    expect(worlds.get(second.id)?.tags).toEqual(['shared']);
    worlds.setTags(second.id, []);
    expect(worlds.listTags()).toEqual([]);
    expect(() => worlds.list({ limit: 0 })).toThrow('INVALID_WORLD_PAGINATION');
  });

  it('preserves a world and its tags while a session refers to it', async () => {
    preset('story');
    model();
    const world = worlds.create({ ...content(), tags: ['bound'] });
    services.sessions.create({
      id: 'session', worldId: world.id, presetId: 'story', apiModelConfigId: 'model', userCharacterId: 'player',
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
