import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../infrastructure/database/connection.js';
import { ModelService } from '../models/service.js';
import { SettingsService } from '../settings/service.js';
import { PresetService, type CreatePresetInput } from './service.js';
import { narrativePreset as preset } from '../../testing/fixtures.js';

let db: DatabaseSync;
let presets: PresetService;
let models: ModelService;
let settings: SettingsService;
beforeEach(() => {
  db = openDatabase(':memory:');
  presets = new PresetService(db);
  models = new ModelService(db);
  settings = new SettingsService(db, { presets, models });
  settings.ensure({ defaultPresetId: null, defaultApiModelConfigId: null });
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

describe('typed preset persistence', () => {
  it('owns a fresh default template and preserves a saved default across repeated ensures', () => {
    const template = presets.getDefault();
    expect(template).toMatchObject({
      type: 'narrative', name: '标准叙事',
      config: { schemaVersion: 1, contextStrategy: { maxContextTokens: 32768, maxOutputTokens: 2048 } },
    });
    template.config.nodes[0]!.prompt = 'changed by caller';
    expect(presets.getDefault().config.nodes[0]!.prompt).not.toBe('changed by caller');
    expect(presets.list()).toEqual([]);
    const first = presets.ensureDefault();
    expect(first.id).toBe('sr-default-preset');
    const changed = presets.update(first.id, { name: 'My saved default' });
    expect(presets.ensureDefault()).toEqual(changed);
    expect(presets.list()).toHaveLength(1);
  });

  it('keeps an existing same-name preset while reserving the fixed default identity', () => {
    const existing = presets.create({ ...preset('标准叙事'), id: 'custom' });
    const seeded = presets.ensureDefault();
    expect(seeded).toMatchObject({ id: 'sr-default-preset', name: '标准叙事(1)' });
    expect(presets.require(existing.id)).toEqual(existing);
    expect(presets.ensureDefault()).toEqual(seeded);
    expect(presets.list()).toHaveLength(2);
  });

  it('round-trips the one versioned config and preserves omitted fields on a partial update', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const created = presets.create({ ...preset(), id: 'preset-story' });
    expect(created).toEqual({ ...preset(), id: 'preset-story', revision: 1, createdAt: 1000, updatedAt: 1000 });
    const stored = db.prepare('SELECT config_json FROM presets WHERE id=?').get(created.id)!;
    expect(JSON.parse(String(stored.config_json))).toHaveProperty('schema_version', 1);
    expect(created).not.toHaveProperty('config_json');
    expect(created.config).not.toHaveProperty('context_strategy');
    clock.mockReturnValue(2000);
    const updated = presets.update(created.id, { name: 'Renamed' })!;
    expect(updated).toMatchObject({ name: 'Renamed', description: 'Narrative preset', createdAt: 1000, updatedAt: 2000 });
    expect(updated.config).toEqual(created.config);
    expect(presets.update(created.id, { description: null })!.description).toBeNull();
    expect(presets.list({ limit: 1 })).toHaveLength(1);
    expect(presets.update('missing', { name: 'Missing' })).toBeNull();
  });

  it('rejects stale saves even when both updates share the same millisecond', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    const first = presets.create(preset());
    const saved = presets.update(first.id, { name: 'First edit' }, first.revision)!;
    expect(saved.revision).toBe(2);
    expect(() => presets.update(first.id, { name: 'Lost edit' }, first.revision)).toThrow('PRESET_REVISION_CONFLICT');
    expect(presets.require(first.id).name).toBe('First edit');
    expect(presets.listPage().items[0]).not.toHaveProperty('config');
  });

  it('preserves unspecified model parameters and permits empty summaries for sliding windows', () => {
    const input = preset();
    delete input.config.modelParameters.temperature;
    input.config.contextStrategy.strategy = 'sliding_window';
    input.config.contextStrategy.summaryPrompt = '';
    const saved = presets.create(input);
    expect(saved.config.modelParameters).not.toHaveProperty('temperature');
    expect(saved.config.contextStrategy.summaryPrompt).toBe('');
    expect(() => presets.update(saved.id, { config: { ...saved.config, contextStrategy: { ...saved.config.contextStrategy, strategy: 'rolling_summary' } } })).toThrow();
  });

  it('enforces same-type names, rejects unimplemented types and legacy config shells', () => {
    const input = preset();
    const created = presets.create(input);
    expect(() => presets.create(input)).toThrow();
    expect(() => presets.create({ ...preset('Image'), type: 'image' } as never)).toThrow();
    expect(() => presets.create({
      ...preset('Legacy'), config: { schemaVersion: 3, nodes: input.config.nodes },
    } as never)).toThrow();
    expect(() => presets.create({ ...preset('Tagged'), tags: ['invalid'] } as never)).toThrow();
    expect(() => presets.create({ ...preset('Old params'), modelParameters: { temperature: 1 } } as never)).toThrow();
    expect(() => presets.update(created.id, {})).toThrow();
    expect(presets.get(created.id)!.config).toEqual(input.config);
  });

  it('permits custom nodes between required nodes while enforcing flat, ordered system nodes', () => {
    const valid = preset();
    valid.config.nodes.splice(2, 0, {
      id: 'extra', name: 'Extra', kind: 'text', role: 'assistant', enabled: false, prompt: '{{world.lore}}',
    });
    expect(presets.create(valid).config.nodes[2]?.id).toBe('extra');

    const unordered = preset('Unordered');
    unordered.config.nodes.reverse();
    expect(() => presets.create(unordered)).toThrow(/顺序/);

    const disabled = preset('Disabled');
    disabled.config.nodes[0]!.enabled = false;
    expect(() => presets.create(disabled)).toThrow(/必须启用/);

    const duplicate = preset('Duplicate');
    duplicate.config.nodes.push({ ...duplicate.config.nodes[0]! });
    expect(() => presets.create(duplicate)).toThrow(/不能重复/);

    const nested = preset('Nested');
    Object.assign(nested.config.nodes[0]!, { children: [] });
    expect(() => presets.create(nested)).toThrow();
  });

  it('validates template ownership and escaping without evaluating user text', () => {
    const unknown = preset('Unknown');
    unknown.config.nodes[0]!.prompt = '{{not.allowed}}';
    expect(() => presets.create(unknown)).toThrow(/未知系统变量/);
    const unfinished = preset('Unfinished');
    unfinished.config.nodes[0]!.prompt = '{{world.lore';
    expect(() => presets.create(unfinished)).toThrow(/缺少结束标记/);
    const misplaced = preset('Misplaced');
    misplaced.config.nodes[0]!.prompt = '{{input.text}}';
    expect(() => presets.create(misplaced)).toThrow(/必须且只能/);
    const duplicated = preset('Duplicated');
    duplicated.config.nodes[4]!.prompt = '{{history.messages}}{{history.messages}}';
    expect(() => presets.create(duplicated)).toThrow(/必须且只能/);
    const literal = preset('Literal');
    literal.config.nodes[0]!.prompt = '\\{{unknown.literal}}';
    expect(presets.create(literal).name).toBe('Literal');
  });

  it('validates narrative parameters and context budgets before any write', () => {
    for (const configure of [
      (input: CreatePresetInput) => { input.config.contextStrategy.maxContextTokens = 1; },
      (input: CreatePresetInput) => { input.config.contextStrategy.maxOutputTokens = Number.MAX_SAFE_INTEGER + 1; },
      (input: CreatePresetInput) => { input.config.modelParameters.temperature = 3; },
      (input: CreatePresetInput) => { input.config.contextStrategy.summaryPrompt = ' '; },
    ]) {
      const input = preset();
      configure(input);
      expect(() => presets.create(input)).toThrow();
    }
    expect(presets.list()).toEqual([]);
  });
});

describe('model configurations and application defaults', () => {
  function model(name = 'Local') {
    return models.create({ name, providerId: 'provider', modelId: 'model', credentialRef: 'vault:model' });
  }

  it('persists references rather than credentials and updates only selected fields', () => {
    const value = model();
    expect(Object.keys(value).every(key => !key.includes('_'))).toBe(true);
    expect(models.get(value.id)).toEqual(value);
    expect(models.update(value.id, { name: 'Renamed' })).toMatchObject({
      name: 'Renamed', providerId: 'provider', modelId: 'model', credentialRef: 'vault:model',
    });
    expect(() => models.create({
      name: 'Secret', providerId: 'provider', modelId: 'model', credentialRef: 'vault:model', apiKey: 'not-a-real-key',
    } as never)).toThrow();
    expect(() => models.update(value.id, { credentialRef: ' ' })).toThrow();
    expect(models.get(value.id)!.credentialRef).toBe('vault:model');
    expect(models.list()).toHaveLength(1);
    expect(models.delete(value.id)).toBe(true);
    expect(models.get(value.id)).toBeNull();
    expect(models.delete(value.id)).toBe(false);
  });

  it('checks both default references before writing and allows explicitly clearing them', () => {
    const presetId = presets.create(preset()).id;
    const modelId = model().id;
    expect(settings.get()).toMatchObject({ id: 1, defaultPresetId: null, defaultApiModelConfigId: null });
    settings.update({ defaultPresetId: presetId, defaultApiModelConfigId: modelId });
    const previous = settings.get();
    expect(Object.keys(previous).every(key => !key.includes('_'))).toBe(true);
    expect(() => settings.update({ defaultPresetId: null, defaultApiModelConfigId: 'missing' })).toThrow('MODEL_CONFIG_NOT_FOUND');
    expect(settings.get()).toEqual(previous);
    expect(() => settings.update({ defaultPresetId: 'missing' })).toThrow('PRESET_NOT_FOUND');
    expect(settings.get()).toEqual(previous);
    expect(() => presets.delete(presetId)).toThrow();
    expect(() => models.delete(modelId)).toThrow();

    settings.update({ defaultPresetId: null });
    expect(settings.get().defaultApiModelConfigId).toBe(modelId);
    expect(presets.delete(presetId)).toBe(true);
    settings.update({ defaultApiModelConfigId: null });
    expect(models.delete(modelId)).toBe(true);
  });
});
