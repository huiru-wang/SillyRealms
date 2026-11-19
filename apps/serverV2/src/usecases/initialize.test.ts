import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../infrastructure/database/connection.js';
import { bindTransaction } from '../infrastructure/database/transaction.js';
import { createServices, type Services } from '../services.js';
import { narrativePreset } from '../testing/fixtures.js';
import { createInitialize } from './initialize.js';

describe('application initialization', () => {
  let database: DatabaseSync, services: Services, dataRoot: string;
  beforeEach(() => {
    database = openDatabase(':memory:');
    dataRoot = mkdtempSync(join(tmpdir(), 'sr-v2-initialize-'));
    services = createServices(database, dataRoot);
  });
  afterEach(() => { database.close(); rmSync(dataRoot, { recursive: true, force: true }); });

  function initialize() {
    return createInitialize({
      presets: services.presets, settings: services.settings, transaction: bindTransaction(database),
    })();
  }

  it('seeds the default preset and settings once, without making storage open seed business data', () => {
    expect(services.settings.getOptional()).toBeNull();
    expect(services.presets.list()).toEqual([]);
    const first = initialize();
    expect(first.defaultPresetId).toBe('sr-default-preset');
    expect(first.defaultApiModelConfigId).toBeNull();
    const preset = services.presets.require(first.defaultPresetId!);
    expect(preset.config.nodes.length).toBeGreaterThan(0);
    expect(initialize()).toEqual(first);
    expect(services.presets.list()).toEqual([preset]);
  });

  it('preserves custom defaults and does not resurrect a deleted built-in preset on restart', () => {
    initialize();
    const preset = services.presets.create(narrativePreset('Custom'));
    const model = services.models.create({
      name: 'Chosen', providerId: 'test', modelId: 'test-model', credentialRef: 'test-ref',
    });
    const settings = services.settings.update({ defaultPresetId: preset.id, defaultApiModelConfigId: model.id });
    services.presets.delete('sr-default-preset');
    expect(initialize()).toEqual(settings);
    expect(services.presets.get('sr-default-preset')).toBeNull();
  });

  it('preserves an explicitly empty configuration instead of interpreting it as first start', () => {
    initialize();
    const settings = services.settings.update({ defaultPresetId: null, defaultApiModelConfigId: null });
    services.presets.delete('sr-default-preset');
    expect(initialize()).toEqual(settings);
    expect(services.presets.list()).toEqual([]);
  });

  it('rolls back both owners on failure and can retry the whole initialization', () => {
    const failing = createInitialize({
      presets: services.presets,
      settings: {
        getOptional: () => services.settings.getOptional(),
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
});
