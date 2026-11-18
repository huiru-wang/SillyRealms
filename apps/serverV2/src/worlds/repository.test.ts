import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../database/connection.js';
import { WorldRepository, type WorldPatch } from './repository.js';

let db: DatabaseSync;
let worlds: WorldRepository;
const content = () => ({
  spec_version: '0.1', name: '雾港',
  characters_json: [{ id: 'player', name: '旅人' }],
  openings_json: [{ id: 'start', content: '船靠岸了。' }],
});

beforeEach(() => {
  db = openDatabase(':memory:');
  worlds = new WorldRepository(db);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

function preset(id: string, type = 'narrative') {
  db.prepare('INSERT INTO presets(id, type, name, config_json, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)')
    .run(id, type, id, '{}', 1, 1);
}
function model() {
  db.prepare('INSERT INTO api_model_configs(id, name, provider_id, model_id, credential_ref, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
    .run('model', 'Model', 'provider', 'model-id', 'credential-ref', 1, 1);
}

describe('world definitions and tags', () => {
  it('persists the approved fields and ordered, deduplicated tag bindings', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const created = worlds.create({
      ...content(), tags: [' 悬疑 ', '城市', '悬疑'], state: { weather: 'rain' },
      state_definition_json: { schema_version: 2, scopes: {} },
      extensions_json: { author: 'test' },
    });
    expect(created.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(created.tags).toEqual(['悬疑', '城市']);
    expect(created.state).toEqual({ weather: 'rain' });
    expect(created.extensions_json).toEqual({ author: 'test' });
    expect(created.created_at).toBe(1000);
    expect(created).not.toHaveProperty('spec');
    expect(created).not.toHaveProperty('source_file_path');
    expect(worlds.get(created.id)).toEqual(created);
    expect(worlds.get('missing')).toBeNull();
    expect(worlds.listTags()).toEqual([{ name: '城市', world_count: 1 }, { name: '悬疑', world_count: 1 }]);
  });

  it('updates content and tags atomically without overwriting runtime state', () => {
    const time = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const original = worlds.create({ ...content(), tags: ['old'], state: { coins: 1 } });
    // StateRepository may have changed this column since the world was opened in an editor.
    db.prepare('UPDATE worlds SET state = ? WHERE id = ?').run('{"coins":99}', original.id);
    time.mockReturnValue(2000);
    const updated = worlds.update(original.id, { name: '新雾港', tags: ['new'], state_definition_json: { initial: 0 } })!;
    expect(updated.name).toBe('新雾港');
    expect(updated.tags).toEqual(['new']);
    expect(updated.state).toEqual({ coins: 99 });
    expect(updated.updated_at).toBe(2000);
    expect(updated.created_at).toBe(1000);
    expect(() => worlds.update(original.id, { state: {} } as unknown as WorldPatch)).toThrow('INVALID_WORLD_FIELD: state');
    expect(worlds.update('missing', { name: 'unused' })).toBeNull();
  });

  it('validates narrative defaults and foreign keys before an atomic tag/content change', () => {
    preset('story');
    preset('image', 'image');
    model();
    const world = worlds.create({ ...content(), tags: ['keep'], default_preset_id: 'story', default_api_model_config_id: 'model' });
    expect(() => worlds.update(world.id, { name: 'lost', tags: ['lost'], default_preset_id: 'image' })).toThrow();
    expect(() => worlds.update(world.id, { name: 'lost', tags: ['lost'], default_api_model_config_id: 'missing' })).toThrow();
    expect(worlds.get(world.id)).toEqual(world);
    expect(() => worlds.create({ ...content(), id: 'failed', default_preset_id: 'image', tags: ['orphan'] })).toThrow();
    expect(worlds.get('failed')).toBeNull();
    expect(worlds.listTags()).toEqual([{ name: 'keep', world_count: 1 }]);
  });

  it('lists by current tag bindings and removes tags only when their world is deleted', () => {
    const first = worlds.create({ ...content(), id: 'first', tags: ['shared', 'only-first'] });
    const second = worlds.create({ ...content(), id: 'second', tags: ['shared'] });
    expect(new Set(worlds.list({ tag: 'shared' }).map(world => world.id))).toEqual(new Set([first.id, second.id]));
    expect(worlds.list({ tag: 'only-first' }).map(world => world.id)).toEqual([first.id]);
    expect(worlds.listTags().find(tag => tag.name === 'shared')?.world_count).toBe(2);
    expect(worlds.delete(first.id)).toBe(true);
    expect(worlds.delete(first.id)).toBe(false);
    expect(worlds.listTags()).toEqual([{ name: 'shared', world_count: 1 }]);
    worlds.setTags(second.id, []);
    expect(worlds.listTags()).toEqual([]);
    expect(() => worlds.list({ limit: 0 })).toThrow('INVALID_WORLD_PAGINATION');
  });

  it('preserves a world and its tags while a session refers to it', () => {
    preset('story');
    model();
    const world = worlds.create({ ...content(), tags: ['bound'] });
    db.prepare('INSERT INTO sessions(id, world_id, preset_id, api_model_config_id, user_character_id, state, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
      .run('session', world.id, 'story', 'model', 'player', '{}', 1, 1);
    expect(() => worlds.delete(world.id)).toThrow();
    expect(worlds.get(world.id)?.tags).toEqual(['bound']);
  });

  it('rejects unsafe IDs, removed metadata and lossy JSON before persistence', () => {
    expect(() => worlds.create({ ...content(), id: '../outside' })).toThrow('INVALID_WORLD_ID');
    expect(() => worlds.create({ ...content(), id: 'UPPERCASE' })).toThrow('INVALID_WORLD_ID');
    expect(() => worlds.create({ ...content(), spec: 'world_card' } as unknown as Parameters<WorldRepository['create']>[0])).toThrow('INVALID_WORLD_FIELD: spec');
    expect(() => worlds.create({ ...content(), characters_json: [NaN] })).toThrow('INVALID_JSON_VALUE');
    expect(() => worlds.create({ ...content(), tags: [''] })).toThrow('INVALID_WORLD_FIELD: tags');
    expect(worlds.list()).toEqual([]);
  });
});
