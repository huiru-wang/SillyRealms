import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../infrastructure/database/connection.js';
import { bindTransaction } from '../infrastructure/database/transaction.js';
import { createServices, type Services } from '../services.js';
import { memoryCredentials } from '../testing/credentials.js';
import { narrativePreset } from '../testing/fixtures.js';
import { createInitialize } from './initialize.js';

describe('application initialization', () => {
  let database: DatabaseSync, services: Services, dataRoot: string;
  beforeEach(() => {
    database = openDatabase(':memory:');
    dataRoot = mkdtempSync(join(tmpdir(), 'sr-v2-initialize-'));
    services = createServices(database, dataRoot, memoryCredentials());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    database.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  function initialize() {
    return createInitialize({
      presets: services.presets, settings: services.settings, transaction: bindTransaction(database),
    })();
  }

  it('fills initial records on first startup and does not rewrite them on later startups', () => {
    expect(services.settings.getOptional()).toBeNull();
    expect(services.presets.list()).toEqual([]);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const first = initialize();
    expect(first.defaultPresetId).toBe('sr-default-preset');
    expect(first.defaultApiModelConfigId).toBeNull();
    const preset = services.presets.require(first.defaultPresetId!);
    expect(preset.config.nodes.length).toBeGreaterThan(0);
    clock.mockReturnValue(2000);
    expect(initialize()).toEqual(first);
    expect(services.presets.list()).toEqual([preset]);
    expect(services.models.list()).toEqual([]);
  });

  it('restores a missing built-in preset without replacing custom default selections', () => {
    initialize();
    const preset = services.presets.create(narrativePreset('Custom'));
    const model = services.models.create({
      name: 'Chosen', providerId: 'test', modelId: 'test-model', credentialRef: 'test-ref',
    });
    const settings = services.settings.update({ defaultPresetId: preset.id, defaultApiModelConfigId: model.id });
    services.presets.delete('sr-default-preset');
    expect(initialize()).toEqual(settings);
    const restored = services.presets.require('sr-default-preset');
    expect(restored).toMatchObject(services.presets.getDefault());
    expect(services.presets.require(preset.id)).toEqual(preset);
    expect(services.models.require(model.id)).toEqual(model);
    expect(initialize()).toEqual(settings);
    expect(services.presets.require(restored.id)).toEqual(restored);
    expect(services.presets.list()).toHaveLength(2);
  });

  it('restores missing initial data while preserving explicitly empty defaults', () => {
    initialize();
    const settings = services.settings.update({ defaultPresetId: null, defaultApiModelConfigId: null });
    services.presets.delete('sr-default-preset');
    expect(initialize()).toEqual(settings);
    expect(services.presets.list().map(preset => preset.id)).toEqual(['sr-default-preset']);
    expect(services.models.list()).toEqual([]);
  });

  it('does not reset a user-edited built-in preset or its revision and timestamps', () => {
    initialize();
    const current = services.presets.require('sr-default-preset');
    const edited = services.presets.update(current.id, {
      name: 'My narrative', description: 'User description',
      config: { ...current.config, modelParameters: { ...current.config.modelParameters, temperature: 0.7 } },
    });
    const settings = services.settings.get();
    vi.spyOn(Date, 'now').mockReturnValue(current.updatedAt + 10_000);
    expect(initialize()).toEqual(settings);
    expect(services.presets.require(current.id)).toEqual(edited);
    expect(services.presets.list()).toHaveLength(1);
  });

  it('recreates only missing settings when the built-in preset already exists and was edited', () => {
    initialize();
    const edited = services.presets.update('sr-default-preset', { name: 'Personalized built-in' });
    database.prepare('DELETE FROM app_settings WHERE id=1').run();
    vi.spyOn(Date, 'now').mockReturnValue(edited!.updatedAt + 10_000);
    const settings = initialize();
    expect(settings).toMatchObject({ defaultPresetId: 'sr-default-preset', defaultApiModelConfigId: null });
    expect(services.presets.list()).toEqual([edited]);
    expect(initialize()).toEqual(settings);
    expect(services.presets.require('sr-default-preset')).toEqual(edited);
  });

  it('uses the stable built-in ID and preserves a custom preset with the same name', () => {
    const template = services.presets.getDefault();
    const custom = services.presets.create({ ...template, id: 'custom-same-name', description: 'Keep this custom record' });
    const settings = initialize();
    expect(settings.defaultPresetId).toBe('sr-default-preset');
    const builtin = services.presets.require('sr-default-preset');
    expect(builtin.name).toBe(template.name + '(1)');
    expect(services.presets.require(custom.id)).toEqual(custom);
    expect(initialize()).toEqual(settings);
    expect(services.presets.require(builtin.id)).toEqual(builtin);
    expect(services.presets.list()).toHaveLength(2);
  });

  it('restores an accidentally removed built-in preset still referenced by settings', () => {
    const settings = initialize();
    // Emulate external data loss in the temporary test database; normal deletes are FK-protected.
    database.exec('PRAGMA foreign_keys=OFF');
    database.prepare('DELETE FROM presets WHERE id=?').run('sr-default-preset');
    database.exec('PRAGMA foreign_keys=ON');
    expect(services.presets.get('sr-default-preset')).toBeNull();
    expect(initialize()).toEqual(settings);
    expect(services.presets.require('sr-default-preset')).toMatchObject(services.presets.getDefault());
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rolls back both owners on failure and can retry the whole initialization', () => {
    const failing = createInitialize({
      presets: services.presets,
      settings: {
        ensure: defaults => {
          services.settings.ensure(defaults);
          throw new Error('settings step failed');
        },
      },
      transaction: bindTransaction(database),
    });
    expect(failing).toThrow('settings step failed');
    expect(services.settings.getOptional()).toBeNull();
    expect(services.presets.list()).toEqual([]);
    expect(initialize().defaultPresetId).toBe('sr-default-preset');
    expect(services.presets.list()).toHaveLength(1);
  });

  it('rolls back a failed repair without changing pre-existing settings or custom data', () => {
    const custom = services.presets.create(narrativePreset('Keep custom'));
    const settings = services.settings.ensure({ defaultPresetId: custom.id, defaultApiModelConfigId: null });
    const failing = createInitialize({
      presets: services.presets,
      settings: { ensure: () => { throw new Error('repair failed'); } },
      transaction: bindTransaction(database),
    });
    expect(failing).toThrow('repair failed');
    expect(services.presets.list()).toEqual([custom]);
    expect(services.settings.get()).toEqual(settings);
    expect(initialize()).toEqual(settings);
    expect(services.presets.require('sr-default-preset')).toMatchObject(services.presets.getDefault());
    expect(services.presets.require(custom.id)).toEqual(custom);
  });
});
