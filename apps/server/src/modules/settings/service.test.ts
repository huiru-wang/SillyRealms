import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../infrastructure/database/connection.js';
import { PresetService } from '../presets/service.js';
import { ModelService } from '../models/service.js';
import { SettingsService } from './service.js';

let db: DatabaseSync, presets: PresetService, models: ModelService, settings: SettingsService;
beforeEach(() => {
  db = openDatabase(':memory:');
  presets = new PresetService(db);
  models = new ModelService(db);
  settings = new SettingsService(db, { presets, models });
});
afterEach(() => db.close());

describe('settings initialization', () => {
  it('distinguishes missing settings and creates the singleton only after reference validation', () => {
    expect(settings.getOptional()).toBeNull();
    expect(() => settings.get()).toThrow('APP_SETTINGS_MISSING');
    expect(() => settings.ensure({ defaultPresetId: 'missing', defaultApiModelConfigId: null })).toThrow('PRESET_NOT_FOUND');
    expect(settings.getOptional()).toBeNull();
    const preset = presets.ensureDefault();
    expect(() => settings.ensure({ defaultPresetId: preset.id, defaultApiModelConfigId: 'missing' })).toThrow('MODEL_CONFIG_NOT_FOUND');
    expect(settings.getOptional()).toBeNull();
    const created = settings.ensure({ defaultPresetId: preset.id, defaultApiModelConfigId: null });
    expect(created).toMatchObject({ id: 1, locale: 'zh-CN', defaultPresetId: preset.id, defaultApiModelConfigId: null });
    expect(settings.get()).toEqual(created);
  });

  it.each(['zh-CN', 'en', 'ja'] as const)('persists %s without resetting it when other settings change or initialization repeats', locale => {
    const preset = presets.ensureDefault();
    settings.ensure({ defaultPresetId: preset.id, defaultApiModelConfigId: null });
    const saved = settings.update({ locale });
    expect(saved.locale).toBe(locale);
    expect(settings.update({ defaultPresetId: null })).toMatchObject({ locale, defaultPresetId: null });
    expect(settings.ensure({ locale: 'zh-CN', defaultPresetId: preset.id, defaultApiModelConfigId: null }))
      .toMatchObject({ locale, defaultPresetId: null });
    expect(new SettingsService(db, { presets, models }).get().locale).toBe(locale);
  });

  it('returns existing choices unchanged instead of treating ensure as an update', () => {
    const preset = presets.ensureDefault();
    settings.ensure({ defaultPresetId: preset.id, defaultApiModelConfigId: null });
    const cleared = settings.update({ defaultPresetId: null });
    expect(settings.ensure({ defaultPresetId: 'ignored-missing', defaultApiModelConfigId: 'ignored-missing' })).toEqual(cleared);
    expect(settings.getOptional()).toEqual(cleared);
    expect(db.prepare('SELECT count(*) AS count FROM app_settings').get()!.count).toBe(1);
  });
});
