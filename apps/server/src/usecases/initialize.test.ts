import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../infrastructure/database/connection.js';
import { bindTransaction } from '../infrastructure/database/transaction.js';
import { EventHub } from '../infrastructure/events/event-hub.js';
import { loadInitialData } from '../infrastructure/initial-data/catalog.js';
import { createUsecases } from '../usecases.js';
import { startServer } from '../server.js';
import { createServices, type Services } from '../services.js';
import { memoryCredentials } from '../testing/credentials.js';
import { narrativePreset } from '../testing/fixtures.js';
import { createImportWorld } from './import-world.js';
import { createInitialize } from './initialize.js';

describe('application initialization', () => {
  let database: DatabaseSync, services: Services, dataRoot: string;
  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'sr-v2-initialize-'));
    database = openDatabase(join(dataRoot, 'database.sqlite'));
    services = createServices(database, dataRoot, memoryCredentials());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    database.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  function dependencies() {
    return {
      presets: services.presets, settings: services.settings, worlds: services.worlds,
      initialWorlds: [], importWorld: createImportWorld(services), transaction: bindTransaction(database),
    };
  }

  function initialize() {
    return createInitialize(dependencies())();
  }

  it('fills initial records on first startup and does not rewrite them on later startups', async () => {
    expect(services.settings.getOptional()).toBeNull();
    expect(services.presets.list()).toEqual([]);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const first = await initialize();
    expect(first.defaultPresetId).toBe('sr-default-preset');
    expect(first.defaultApiModelConfigId).toBeNull();
    const preset = services.presets.require(first.defaultPresetId!);
    expect(preset.config.nodes.length).toBeGreaterThan(0);
    clock.mockReturnValue(2000);
    expect(await initialize()).toEqual(first);
    expect(services.presets.list()).toEqual([preset]);
    expect(services.models.list()).toEqual([]);
  });

  it('restores a missing built-in preset without replacing custom default selections', async () => {
    await initialize();
    const preset = services.presets.create(narrativePreset('Custom'));
    const model = services.models.create({
      name: 'Chosen', providerId: 'test', modelId: 'test-model', credentialRef: 'test-ref',
    });
    const settings = services.settings.update({ defaultPresetId: preset.id, defaultApiModelConfigId: model.id });
    services.presets.delete('sr-default-preset');
    expect(await initialize()).toEqual(settings);
    const restored = services.presets.require('sr-default-preset');
    expect(restored).toMatchObject(services.presets.getDefault());
    expect(services.presets.require(preset.id)).toEqual(preset);
    expect(services.models.require(model.id)).toEqual(model);
    expect(await initialize()).toEqual(settings);
    expect(services.presets.require(restored.id)).toEqual(restored);
    expect(services.presets.list()).toHaveLength(2);
  });

  it('restores missing initial data while preserving explicitly empty defaults', async () => {
    await initialize();
    const settings = services.settings.update({ defaultPresetId: null, defaultApiModelConfigId: null });
    services.presets.delete('sr-default-preset');
    expect(await initialize()).toEqual(settings);
    expect(services.presets.list().map(preset => preset.id)).toEqual(['sr-default-preset']);
    expect(services.models.list()).toEqual([]);
  });

  it('does not reset a user-edited built-in preset or its revision and timestamps', async () => {
    await initialize();
    const current = services.presets.require('sr-default-preset');
    const edited = services.presets.update(current.id, {
      name: 'My narrative', description: 'User description',
      config: { ...current.config, modelParameters: { ...current.config.modelParameters, temperature: 0.7 } },
    });
    const settings = services.settings.get();
    vi.spyOn(Date, 'now').mockReturnValue(current.updatedAt + 10_000);
    expect(await initialize()).toEqual(settings);
    expect(services.presets.require(current.id)).toEqual(edited);
    expect(services.presets.list()).toHaveLength(1);
  });

  it('recreates only missing settings when the built-in preset already exists and was edited', async () => {
    await initialize();
    const edited = services.presets.update('sr-default-preset', { name: 'Personalized built-in' });
    database.prepare('DELETE FROM app_settings WHERE id=1').run();
    vi.spyOn(Date, 'now').mockReturnValue(edited!.updatedAt + 10_000);
    const settings = await initialize();
    expect(settings).toMatchObject({ defaultPresetId: 'sr-default-preset', defaultApiModelConfigId: null });
    expect(services.presets.list()).toEqual([edited]);
    expect(await initialize()).toEqual(settings);
    expect(services.presets.require('sr-default-preset')).toEqual(edited);
  });

  it('uses the stable built-in ID and preserves a custom preset with the same name', async () => {
    const template = services.presets.getDefault();
    const custom = services.presets.create({ ...template, id: 'custom-same-name', description: 'Keep this custom record' });
    const settings = await initialize();
    expect(settings.defaultPresetId).toBe('sr-default-preset');
    const builtin = services.presets.require('sr-default-preset');
    expect(builtin.name).toBe(template.name + '(1)');
    expect(services.presets.require(custom.id)).toEqual(custom);
    expect(await initialize()).toEqual(settings);
    expect(services.presets.require(builtin.id)).toEqual(builtin);
    expect(services.presets.list()).toHaveLength(2);
  });

  it('restores an accidentally removed built-in preset still referenced by settings', async () => {
    const settings = await initialize();
    // Emulate external data loss in the temporary test database; normal deletes are FK-protected.
    database.exec('PRAGMA foreign_keys=OFF');
    database.prepare('DELETE FROM presets WHERE id=?').run('sr-default-preset');
    database.exec('PRAGMA foreign_keys=ON');
    expect(services.presets.get('sr-default-preset')).toBeNull();
    expect(await initialize()).toEqual(settings);
    expect(services.presets.require('sr-default-preset')).toMatchObject(services.presets.getDefault());
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rolls back both owners on failure and can retry the whole initialization', async () => {
    const failing = createInitialize({
      ...dependencies(),
      settings: {
        ensure: defaults => {
          services.settings.ensure(defaults);
          throw new Error('settings step failed');
        },
      },
    });
    await expect(failing()).rejects.toThrow('settings step failed');
    expect(services.settings.getOptional()).toBeNull();
    expect(services.presets.list()).toEqual([]);
    expect((await initialize()).defaultPresetId).toBe('sr-default-preset');
    expect(services.presets.list()).toHaveLength(1);
  });

  it('rolls back a failed repair without changing pre-existing settings or custom data', async () => {
    const custom = services.presets.create(narrativePreset('Keep custom'));
    const settings = services.settings.ensure({ defaultPresetId: custom.id, defaultApiModelConfigId: null });
    const failing = createInitialize({
      ...dependencies(),
      settings: { ensure: () => { throw new Error('repair failed'); } },
    });
    await expect(failing()).rejects.toThrow('repair failed');
    expect(services.presets.list()).toEqual([custom]);
    expect(services.settings.get()).toEqual(settings);
    expect(await initialize()).toEqual(settings);
    expect(services.presets.require('sr-default-preset')).toMatchObject(services.presets.getDefault());
    expect(services.presets.require(custom.id)).toEqual(custom);
  });

  it('installs the release ZIP and preserves edited state and assets on restart', async () => {
    const init = createUsecases({ services, events: new EventHub(), transaction: bindTransaction(database) }).initialize;
    const entry = services.initialWorlds[0]!;
    const read = vi.spyOn(entry, 'readBytes');
    await init();
    const world = services.worlds.require('sr-world-xiaofanguan');
    expect(world).toMatchObject({
      name: '小饭馆', tags: ['古风日常', '市井', '美食'], state: {}, cover: 'sr-asset://assets/cover.png',
      defaultPresetId: 'sr-default-preset', defaultApiModelConfigId: null,
    });
    expect(services.sessions.list()).toEqual([]);
    expect(services.models.list()).toEqual([]);
    const original = await services.worlds.readOriginal(world.id);
    expect(original?.format).toBe('zip');
    expect(Buffer.from(original!.bytes).equals(await read.mock.results[0]!.value)).toBe(true);
    const components = await services.worlds.getComponents(world.id);
    expect(components.errors).toEqual({});
    expect(components.items.map(item => item.id)).toEqual(['InnStage', 'InnIntroduction', 'InnLedger']);
    const cover = (await services.worlds.resolvePackageFile(world.id, 'assets/cover.png')).path;
    expect(readFileSync(cover).subarray(1, 4).toString()).toBe('PNG');

    services.worlds.updateManagement(world.id, { name: '自己的饭馆', expectedRevision: world.revision });
    services.worlds.setState(world.id, { coins: 17 });
    const edited = services.worlds.require(world.id);
    writeFileSync(cover, 'user asset');
    expect(read).toHaveBeenCalledOnce();
    database.close();
    database = openDatabase(join(dataRoot, 'database.sqlite'));
    services = createServices(database, dataRoot, memoryCredentials());
    const reopened = createUsecases({ services, events: new EventHub(), transaction: bindTransaction(database) }).initialize;
    const readOnRestart = vi.spyOn(services.initialWorlds[0]!, 'readBytes');
    await reopened();
    expect(readOnRestart).not.toHaveBeenCalled();
    expect(services.worlds.list()).toEqual([edited]);
    expect(readFileSync(cover, 'utf8')).toBe('user asset');

    await services.worlds.delete(world.id);
    await reopened();
    expect(readOnRestart).toHaveBeenCalledOnce();
    expect(services.worlds.require(world.id)).toMatchObject({ name: world.name, state: world.state });
    expect(readFileSync(cover).subarray(1, 4).toString()).toBe('PNG');
  });

  it('preserves a same-name manual world and session when adding the release world to an old database', async () => {
    const preset = services.presets.create(narrativePreset('Custom'));
    const model = services.models.create({ name: 'Chosen', providerId: 'test', modelId: 'test', credentialRef: 'test' });
    const defaults = { defaultPresetId: preset.id, defaultApiModelConfigId: model.id };
    services.settings.ensure(defaults);
    const importWorld = createImportWorld(services);
    const manual = await importWorld({ format: 'zip', bytes: await services.initialWorlds[0]!.readBytes() });
    const session = services.sessions.create({
      worldId: manual.id, presetId: preset.id, apiModelConfigId: model.id, userCharacterId: 'keeper',
    });
    await createInitialize({ ...dependencies(), initialWorlds: services.initialWorlds })();
    expect(services.worlds.require('sr-world-xiaofanguan')).toMatchObject({ name: manual.name, ...defaults });
    expect(services.worlds.require(manual.id)).toEqual(manual);
    expect(services.sessions.get(session.id)).toEqual(session);
    expect(services.worlds.list()).toHaveLength(2);
  });

  it('retries only missing resources after a later world fails to import', async () => {
    const catalog = loadInitialData();
    const first = catalog.presets[0]!;
    catalog.presets.push({ ...first, id: 'extra-template' });
    const world = catalog.worlds[0]!;
    const readFirst = vi.spyOn(world, 'readBytes');
    catalog.worlds.push({ id: 'extra-world', file: 'extra.zip', readBytes: () => Promise.resolve(Buffer.from('invalid')) });
    services = createServices(database, dataRoot, memoryCredentials(), catalog);
    const init = createUsecases({ services, events: new EventHub(), transaction: bindTransaction(database) }).initialize;
    await expect(init()).rejects.toThrow(/worlds\/extra.zip.*extra-world.*INVALID_WORLD_PACKAGE/);
    expect(services.presets.require('extra-template').name).toBe('标准叙事(1)');
    expect(services.worlds.list().map(item => item.id)).toEqual([world.id]);
    catalog.worlds[1]!.readBytes = loadInitialData().worlds[0]!.readBytes;
    await init();
    expect(readFirst).toHaveBeenCalledOnce();
    expect(services.worlds.list()).toHaveLength(2);
  });

  it('reports the install target and retains existing files when the database record is absent', async () => {
    const id = services.initialWorlds[0]!.id;
    const directory = join(dataRoot, 'worlds', id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'retained'), 'original bytes');
    const listen = vi.spyOn(Server.prototype, 'listen').mockImplementation(() => { throw new Error('unexpected listen'); });
    await expect(startServer({ dataRoot, credentialStore: memoryCredentials() }))
      .rejects.toThrow('data path worlds/' + id + '): RESOURCE_CONFLICT');
    expect(listen).not.toHaveBeenCalled();
    expect(readFileSync(join(directory, 'retained'), 'utf8')).toBe('original bytes');
    expect(services.worlds.get(id)).toBeNull();
  });
});
