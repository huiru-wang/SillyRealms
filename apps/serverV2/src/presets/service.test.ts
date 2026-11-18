import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../database/connection.js';
import { ModelService } from '../models/service.js';
import { SettingsService } from '../settings/service.js';
import { PresetService, type CreatePresetInput } from './service.js';
import { narrativePreset as preset } from '../testing/fixtures.js';

let db: DatabaseSync;
let presets: PresetService;
let models: ModelService;
let settings: SettingsService;
beforeEach(() => {
  db = openDatabase(':memory:');
  presets = new PresetService(db);
  models = new ModelService(db);
  settings = new SettingsService(db, { presets, models });
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

describe('typed preset persistence', () => {
  it('round-trips the one versioned config and preserves omitted fields on a partial update', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const created = presets.create({ ...preset(), id: 'preset-story' });
    expect(created).toMatchObject({ ...preset(), id: 'preset-story', created_at: 1000, updated_at: 1000 });
    const stored = db.prepare('SELECT config_json FROM presets WHERE id=?').get(created.id)!;
    expect(JSON.parse(String(stored.config_json))).toEqual(preset().config_json);
    clock.mockReturnValue(2000);
    const updated = presets.update(created.id, { name: 'Renamed' })!;
    expect(updated).toMatchObject({ name: 'Renamed', description: 'Narrative preset', created_at: 1000, updated_at: 2000 });
    expect(updated.config_json).toEqual(created.config_json);
    expect(presets.update(created.id, { description: null })!.description).toBeNull();
    expect(presets.list({ limit: 1 })).toHaveLength(1);
    expect(presets.update('missing', { name: 'Missing' })).toBeNull();
  });

  it('enforces same-type names, rejects unimplemented types and legacy config shells', () => {
    const input = preset();
    const created = presets.create(input);
    expect(() => presets.create(input)).toThrow();
    expect(() => presets.create({ ...preset('Image'), type: 'image' } as never)).toThrow();
    expect(() => presets.create({
      ...preset('Legacy'), config_json: { schemaVersion: 3, nodes: input.config_json.nodes },
    } as never)).toThrow();
    expect(() => presets.create({ ...preset('Tagged'), tags: ['invalid'] } as never)).toThrow();
    expect(() => presets.create({ ...preset('Old params'), model_parameters: { temperature: 1 } } as never)).toThrow();
    expect(() => presets.update(created.id, {})).toThrow();
    expect(presets.get(created.id)!.config_json).toEqual(input.config_json);
  });

  it('permits custom nodes between required nodes while enforcing flat, ordered system nodes', () => {
    const valid = preset();
    valid.config_json.nodes.splice(2, 0, {
      id: 'extra', name: 'Extra', kind: 'text', role: 'assistant', enabled: false, prompt: '{{world.lore}}',
    });
    expect(presets.create(valid).config_json.nodes[2]?.id).toBe('extra');

    const unordered = preset('Unordered');
    unordered.config_json.nodes.reverse();
    expect(() => presets.create(unordered)).toThrow(/顺序/);

    const disabled = preset('Disabled');
    disabled.config_json.nodes[0]!.enabled = false;
    expect(() => presets.create(disabled)).toThrow(/必须启用/);

    const duplicate = preset('Duplicate');
    duplicate.config_json.nodes.push({ ...duplicate.config_json.nodes[0]! });
    expect(() => presets.create(duplicate)).toThrow(/不能重复/);

    const nested = preset('Nested');
    Object.assign(nested.config_json.nodes[0]!, { children: [] });
    expect(() => presets.create(nested)).toThrow();
  });

  it('validates template ownership and escaping without evaluating user text', () => {
    const unknown = preset('Unknown');
    unknown.config_json.nodes[0]!.prompt = '{{not.allowed}}';
    expect(() => presets.create(unknown)).toThrow(/未知系统变量/);
    const unfinished = preset('Unfinished');
    unfinished.config_json.nodes[0]!.prompt = '{{world.lore';
    expect(() => presets.create(unfinished)).toThrow(/缺少结束标记/);
    const misplaced = preset('Misplaced');
    misplaced.config_json.nodes[0]!.prompt = '{{input.text}}';
    expect(() => presets.create(misplaced)).toThrow(/必须且只能/);
    const duplicated = preset('Duplicated');
    duplicated.config_json.nodes[4]!.prompt = '{{history.messages}}{{history.messages}}';
    expect(() => presets.create(duplicated)).toThrow(/必须且只能/);
    const literal = preset('Literal');
    literal.config_json.nodes[0]!.prompt = '\\{{unknown.literal}}';
    expect(presets.create(literal).name).toBe('Literal');
  });

  it('validates narrative parameters and context budgets before any write', () => {
    for (const configure of [
      (input: CreatePresetInput) => { input.config_json.context_strategy.max_context_tokens = 1; },
      (input: CreatePresetInput) => { input.config_json.context_strategy.max_output_tokens = Number.MAX_SAFE_INTEGER + 1; },
      (input: CreatePresetInput) => { input.config_json.model_parameters.temperature = 3; },
      (input: CreatePresetInput) => { input.config_json.context_strategy.summary_prompt = ' '; },
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
    return models.create({ name, provider_id: 'provider', model_id: 'model', credential_ref: 'vault:model' });
  }

  it('persists references rather than credentials and updates only selected fields', () => {
    const value = model();
    expect(models.get(value.id)).toEqual(value);
    expect(models.update(value.id, { name: 'Renamed' })).toMatchObject({
      name: 'Renamed', provider_id: 'provider', model_id: 'model', credential_ref: 'vault:model',
    });
    expect(() => models.create({
      name: 'Secret', provider_id: 'provider', model_id: 'model', credential_ref: 'vault:model', apiKey: 'not-a-real-key',
    } as never)).toThrow();
    expect(() => models.update(value.id, { credential_ref: ' ' })).toThrow();
    expect(models.get(value.id)!.credential_ref).toBe('vault:model');
    expect(models.list()).toHaveLength(1);
    expect(models.delete(value.id)).toBe(true);
    expect(models.get(value.id)).toBeNull();
    expect(models.delete(value.id)).toBe(false);
  });

  it('checks both default references atomically and allows explicitly clearing them', () => {
    const presetId = presets.create(preset()).id;
    const modelId = model().id;
    expect(settings.get()).toMatchObject({ id: 1, default_preset_id: null, default_api_model_config_id: null });
    settings.update({ default_preset_id: presetId, default_api_model_config_id: modelId });
    const previous = settings.get();
    expect(() => settings.update({ default_preset_id: null, default_api_model_config_id: 'missing' })).toThrow('MODEL_CONFIG_NOT_FOUND');
    expect(settings.get()).toEqual(previous);
    expect(() => settings.update({ default_preset_id: 'missing' })).toThrow('PRESET_NOT_FOUND');
    expect(settings.get()).toEqual(previous);
    expect(() => presets.delete(presetId)).toThrow();
    expect(() => models.delete(modelId)).toThrow();

    settings.update({ default_preset_id: null });
    expect(settings.get().default_api_model_config_id).toBe(modelId);
    expect(presets.delete(presetId)).toBe(true);
    settings.update({ default_api_model_config_id: null });
    expect(models.delete(modelId)).toBe(true);
  });
});
