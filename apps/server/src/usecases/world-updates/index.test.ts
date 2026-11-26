import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../errors.js';
import { openDatabase } from '../../infrastructure/database/connection.js';
import { bindTransaction } from '../../infrastructure/database/transaction.js';
import { EventHub, type SessionEvent } from '../../infrastructure/events/event-hub.js';
import { createServices } from '../../services.js';
import { narrativePreset } from '../../testing/fixtures.js';
import { worldCardFixture } from '../../modules/worlds/test-fixtures.js';
import type { World, WorldImportInput } from '../../modules/worlds/service.js';
import { createImportWorld } from '../import-world.js';
import { createDeleteWorld } from '../delete-world.js';
import { createWorldUpdates, type WorldUpdates, type WorldReleaseRecord } from './index.js';

const packageId = '49e876ea-152b-4d13-a75d-6d342211a127';
const updateUrl = 'https://publisher.example/releases.json';
function card(version: string) {
  const value = worldCardFixture();
  return { ...value, spec_version: '0.2', data: { ...value.data,
    publication: { package_id: packageId, authors: [{ name: '作者' }], creator_notes: '作者说明',
      release: { version, published_at: '2026-11-26T00:00:00Z', notes: 'Release ' + version }, update_url: updateUrl },
    characters: value.data.characters.map(character => ({ ...character, prompt: 'Prompt ' + version })),
  } };
}
function artifact(version: string): WorldImportInput { return { format: 'json', bytes: Buffer.from(JSON.stringify(card(version))) }; }
function record(version: string): WorldReleaseRecord {
  const input = artifact(version);
  return { version, published_at: '2026-11-26T00:00:00Z', notes: 'Release ' + version, spec_version: '0.2',
    artifact: { format: 'json', url: 'https://cdn.example/' + version + '.json', sha256: createHash('sha256').update(input.bytes).digest('hex'), size_bytes: input.bytes.length } };
}
function indexText(versions = ['1.0.0', '2.0.0']) {
  return JSON.stringify({ schema_version: 1, package_id: packageId, publisher_extension: { keep: true }, versions: versions.map(record) }, null, 3) + '\n';
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let db: DatabaseSync, root: string, services: ReturnType<typeof createServices>, updates: WorldUpdates;
let world: World, events: EventHub;
const downloads = {
  getIndex: vi.fn<(url: string, signal: AbortSignal) => Promise<string>>(),
  getArtifact: vi.fn<(release: WorldReleaseRecord, signal: AbortSignal) => Promise<WorldImportInput>>(),
};
function newUpdates() { return createWorldUpdates({ ...services, events, downloads }); }
function apply(version = '2.0.0') {
  return updates.applyVersion(world.id, { version, expectedSha256: record(version).artifact.sha256, expectedRevision: services.worlds.require(world.id).revision });
}
beforeEach(async () => {
  db = openDatabase(':memory:');
  root = await mkdtemp(join(tmpdir(), 'sr-world-updates-'));
  services = createServices(db, root);
  services.settings.ensure({ defaultPresetId: null, defaultApiModelConfigId: null });
  events = new EventHub();
  downloads.getIndex.mockReset().mockResolvedValue(indexText());
  downloads.getArtifact.mockReset().mockImplementation(async release => artifact(release.version));
  world = await createImportWorld(services)(artifact('1.0.0'));
  updates = newUpdates();
});
afterEach(async () => {
  await updates.shutdown();
  vi.restoreAllMocks();
  db.close();
  await rm(root, { recursive: true, force: true });
});

describe('world update orchestration', () => {
  it('keeps reads offline, shares in-flight refresh and saves only the exact successful response', async () => {
    expect(await updates.getVersions(world.id)).toMatchObject({ currentVersion: '1.0.0', updateStatus: 'not_checked', versions: [] });
    expect(downloads.getIndex).not.toHaveBeenCalled();
    const started = deferred<AbortSignal>(), reply = deferred<string>();
    downloads.getIndex.mockImplementationOnce(async (_url, signal) => { started.resolve(signal); return reply.promise; });
    const first = updates.refresh(world.id), second = updates.refresh(world.id);
    expect(first).toBe(second);
    await started.promise;
    expect(await updates.getVersions(world.id)).toMatchObject({ updateStatus: 'checking', lastAttemptAt: expect.any(Number) });
    reply.resolve(indexText());
    expect(await first).toMatchObject({ updateStatus: 'ready', latestVersion: '2.0.0', versions: [{ version: '2.0.0', supported: true }, { version: '1.0.0' }] });
    expect((await services.worlds.readReleaseIndex(world.id))!.text).toBe(indexText());
    await updates.getSummaries([world, world]);
    expect(downloads.getIndex).toHaveBeenCalledTimes(1);
    await updates.refresh(world.id);
    expect(downloads.getIndex).toHaveBeenCalledTimes(2);
  });

  it('projects list summaries without loading complete world contents', async () => {
    await updates.refresh(world.id);
    const page = services.worlds.listPage();
    vi.spyOn(services.worlds, 'get').mockImplementation(() => { throw new Error('Full world read is not needed for a summary'); });
    expect(await updates.getSummaries(page.items)).toEqual({
      [world.id]: { currentVersion: '1.0.0', latestVersion: '2.0.0', updateStatus: 'ready' },
    });
  });

  it('retains last-good raw bytes and mtime on failure and restores from disk after restart', async () => {
    await updates.refresh(world.id);
    const before = await services.worlds.readReleaseIndex(world.id);
    downloads.getIndex.mockRejectedValueOnce(new AppError('WORLD_DOWNLOAD_FAILED'));
    await expect(updates.refresh(world.id)).rejects.toThrow('WORLD_DOWNLOAD_FAILED');
    expect(await updates.getVersions(world.id)).toMatchObject({ updateStatus: 'failed', latestVersion: '2.0.0', lastSuccessAt: before!.mtimeMs, errorCode: 'WORLD_DOWNLOAD_FAILED' });
    expect(await services.worlds.readReleaseIndex(world.id)).toEqual(before);
    await updates.shutdown();
    updates = newUpdates();
    expect(await updates.getVersions(world.id)).toMatchObject({ updateStatus: 'ready', lastAttemptAt: null, errorCode: null, lastSuccessAt: before!.mtimeMs });
  });

  it('treats corrupt or foreign local files as no usable cache, without making network calls', async () => {
    for (const text of ['{broken', indexText().replace(packageId, 'aa317326-b7fa-4850-ad52-1e7e98fa6b6f')]) {
      await services.worlds.saveReleaseIndex(world.id, { packageId, updateUrl, text }, () => true);
      expect(await updates.getVersions(world.id)).toMatchObject({ updateStatus: 'not_checked', latestVersion: null,
        lastSuccessAt: null, lastAttemptAt: null, errorCode: null, versions: [] });
    }
    expect(downloads.getIndex).not.toHaveBeenCalled();
    expect(await updates.refresh(world.id)).toMatchObject({ updateStatus: 'ready', latestVersion: '2.0.0' });
  });

  it('accepts a cached empty index and rejects same-version hash rewrites without losing it', async () => {
    await updates.refresh(world.id);
    const altered = JSON.parse(indexText());
    altered.versions[0].artifact.sha256 = 'f'.repeat(64);
    downloads.getIndex.mockResolvedValueOnce(JSON.stringify(altered));
    await expect(updates.refresh(world.id)).rejects.toThrow('WORLD_UPDATE_CONFLICT');
    expect((await services.worlds.readReleaseIndex(world.id))!.text).toBe(indexText());
    downloads.getIndex.mockResolvedValueOnce(indexText([]));
    expect(await updates.refresh(world.id)).toMatchObject({ updateStatus: 'ready', latestVersion: null, versions: [], lastSuccessAt: expect.any(Number) });
  });

  it('invalidates a deleted world before a late response can recreate its directory', async () => {
    const started = deferred<AbortSignal>(), reply = deferred<string>();
    downloads.getIndex.mockImplementationOnce(async (_url, signal) => { started.resolve(signal); return reply.promise; });
    const pending = updates.refresh(world.id), rejected = expect(pending).rejects.toThrow('WORLD_UPDATE_CANCELLED');
    const signal = await started.promise;
    const remove = createDeleteWorld({ ...services, transaction: bindTransaction(db), onWorldDeleted: updates.cancelForWorld });
    await remove(world.id);
    expect(signal.aborted).toBe(true);
    reply.resolve(indexText());
    await rejected;
    expect(services.worlds.get(world.id)).toBeNull();
    expect(await readdir(join(root, 'worlds'))).not.toContain(world.id);
  });

  it('aborts and drains checks before shutdown completes, ignoring transports that resolve late', async () => {
    const started = deferred<AbortSignal>(), reply = deferred<string>();
    downloads.getIndex.mockImplementationOnce(async (_url, signal) => { started.resolve(signal); return reply.promise; });
    const pending = updates.refresh(world.id), rejected = expect(pending).rejects.toThrow('WORLD_UPDATE_CANCELLED');
    const signal = await started.promise;
    const stopping = updates.shutdown();
    expect(signal.aborted).toBe(true);
    expect(updates.shutdown()).toBe(stopping);
    reply.resolve(indexText());
    await rejected;
    await stopping;
    expect(await services.worlds.readReleaseIndex(world.id)).toBeNull();
    expect(() => updates.refresh(world.id)).toThrow('WORLD_UPDATE_CANCELLED');
  });

  it('runs startup once with bounded concurrency and reuses a manual in-flight check', async () => {
    for (let i = 0; i < 5; i++) await createImportWorld(services)(artifact('1.0.0'));
    const sources = services.worlds.listUpdateSources().sort((a, b) => a.worldId === world.id ? -1 : b.worldId === world.id ? 1 : a.worldId.localeCompare(b.worldId));
    vi.spyOn(services.worlds, 'listUpdateSources').mockReturnValue(sources);
    const ready = deferred<void>(), gate = deferred<string>();
    let active = 0, maximum = 0, calls = 0;
    downloads.getIndex.mockImplementation(async () => {
      active++; maximum = Math.max(maximum, active);
      if (++calls === 3) ready.resolve();
      const result = await gate.promise;
      active--;
      return result;
    });
    const manual = updates.refresh(world.id);
    const startup = updates.checkAtStartup();
    expect(updates.checkAtStartup()).toBe(startup);
    await ready.promise;
    expect(maximum).toBe(3);
    gate.resolve(indexText());
    await Promise.all([manual, startup]);
    expect(maximum).toBeLessThanOrEqual(3);
    expect(downloads.getIndex).toHaveBeenCalledTimes(6);
  });

  it('keeps legacy/offline worlds offline and reports unknown future card formats without applying them', async () => {
    const legacy = await createImportWorld(services)({ format: 'json', bytes: Buffer.from(JSON.stringify(worldCardFixture())) });
    expect(await updates.getVersions(legacy.id)).toMatchObject({ currentVersion: null, updateStatus: 'no_source' });
    expect(() => updates.refresh(legacy.id)).toThrow('WORLD_UPDATE_NO_SOURCE');
    const future = { ...record('3.0.0'), spec_version: '0.9' };
    downloads.getIndex.mockResolvedValueOnce(JSON.stringify({ schema_version: 1, package_id: packageId, versions: [record('2.0.0'), future] }));
    expect(await updates.refresh(world.id)).toMatchObject({ latestVersion: '3.0.0', versions: [{ version: '3.0.0', supported: false }, { version: '2.0.0', supported: true }] });
    await expect(apply('3.0.0')).rejects.toThrow('WORLD_RELEASE_UNSUPPORTED');
    expect(downloads.getArtifact).not.toHaveBeenCalled();
  });

  it('upgrades and rolls back the same world while retaining local management, all sessions and state', async () => {
    const preset = services.presets.create(narrativePreset());
    const model = services.models.create({ name: 'Model', providerId: 'test', modelId: 'test', credentialRef: 'never-used' });
    world = services.worlds.updateManagement(world.id, { expectedRevision: world.revision, name: '本地名称', tags: ['本地标签'], coverMosaicEnabled: true, defaultPresetId: preset.id, defaultApiModelConfigId: model.id });
    services.worlds.setState(world.id, { coins: 99, extra: true });
    const session = services.sessions.create({ worldId: world.id, userCharacterId: 'player', runtimeConfig: { narrativePresetId: preset.id, apiModelConfigId: model.id }, state: { personal: 'keep' } });
    const entry = services.sessions.appendEntry(session.id, { type: 'message', role: 'user', runId: 'run', payload: { content: 'keep history' } });
    const messages: SessionEvent[] = [];
    events.subscribe(session.id, event => { services.cache.assertWorldRead(world.id); messages.push(event); });
    const originalSession = services.sessions.require(session.id);
    await updates.refresh(world.id);
    const cached = await services.worlds.readReleaseIndex(world.id);
    const upgraded = await apply();
    expect(upgraded).toMatchObject({ id: world.id, revision: world.revision + 1, name: '本地名称', tags: ['本地标签'], coverMosaicEnabled: true,
      defaultPresetId: preset.id, defaultApiModelConfigId: model.id, state: { coins: 99, extra: true }, publication: { release: { version: '2.0.0' }, update_url: updateUrl } });
    expect(upgraded.characters[0]).toMatchObject({ prompt: 'Prompt 2.0.0' });
    expect(services.sessions.require(session.id)).toEqual(originalSession);
    expect(services.sessions.getEntry(session.id, entry.id)).toEqual(entry);
    expect(await services.worlds.readReleaseIndex(world.id)).toEqual(cached);
    expect((await services.worlds.readOriginal(world.id))!.bytes).toEqual(Buffer.from(artifact('2.0.0').bytes));
    expect(messages).toEqual([{ event: 'world.updated', data: { sessionId: session.id, worldId: world.id, version: '2.0.0', revision: upgraded.revision, timestamp: expect.any(Number) } }]);
    const reverted = await apply('1.0.0');
    expect(reverted.publication!.release.version).toBe('1.0.0');
    expect(reverted.revision).toBe(upgraded.revision + 1);
    expect(reverted.state).toEqual(upgraded.state);
    expect(messages).toHaveLength(2);
    expect(await readdir(join(root, 'staging'))).toEqual([]);
  });

  it('rechecks revision and active runs after downloading without modifying the installed version', async () => {
    await updates.refresh(world.id);
    const started = deferred<void>(), download = deferred<WorldImportInput>();
    downloads.getArtifact.mockImplementationOnce(async () => { started.resolve(); return download.promise; });
    const pending = apply(), rejected = expect(pending).rejects.toThrow('WORLD_UPDATE_BUSY');
    await started.promise;
    const run = services.cache.acquireRun({ worldId: world.id, sessionId: 'running', runId: 'run' });
    download.resolve(artifact('2.0.0'));
    await rejected;
    services.cache.releaseRun(run);
    expect(services.worlds.require(world.id)).toEqual(world);
    expect(await readdir(join(root, 'staging'))).toEqual([]);

    const nextStarted = deferred<void>(), nextDownload = deferred<WorldImportInput>();
    downloads.getArtifact.mockImplementationOnce(async () => { nextStarted.resolve(); return nextDownload.promise; });
    const next = apply(), conflict = expect(next).rejects.toThrow('WORLD_REVISION_CONFLICT');
    await nextStarted.promise;
    services.worlds.updateManagement(world.id, { expectedRevision: world.revision, name: 'Changed elsewhere' });
    nextDownload.resolve(artifact('2.0.0'));
    await conflict;
    expect(services.worlds.require(world.id).publication!.release.version).toBe('1.0.0');
  });

  it('rejects a version withdrawn during download and discards its staging files', async () => {
    await updates.refresh(world.id);
    const started = deferred<void>(), download = deferred<WorldImportInput>();
    downloads.getArtifact.mockImplementationOnce(async () => { started.resolve(); return download.promise; });
    const pending = apply(), rejected = expect(pending).rejects.toThrow('WORLD_RELEASE_NOT_FOUND');
    await started.promise;
    downloads.getIndex.mockResolvedValueOnce(indexText(['1.0.0']));
    await updates.refresh(world.id);
    download.resolve(artifact('2.0.0'));
    await rejected;
    expect(services.worlds.require(world.id)).toEqual(world);
    expect(await readdir(join(root, 'staging'))).toEqual([]);
  });

  it('blocks all same-world writes while replacing, then releases the admission before publishing', async () => {
    await updates.refresh(world.id);
    const preset = services.presets.create(narrativePreset()), model = services.models.create({ name: 'm', providerId: 'p', modelId: 'm', credentialRef: 'unused' });
    const session = services.sessions.create({ worldId: world.id, userCharacterId: 'player', runtimeConfig: { narrativePresetId: preset.id, apiModelConfigId: model.id } });
    const entered = deferred<void>(), resume = deferred<void>();
    const replace = services.worlds.applyPreparedReplacement.bind(services.worlds);
    vi.spyOn(services.worlds, 'applyPreparedReplacement').mockImplementationOnce(async (stage, options) => { entered.resolve(); await resume.promise; return replace(stage, options); });
    const pending = apply();
    await entered.promise;
    expect(() => services.worlds.updateManagement(world.id, { expectedRevision: world.revision, name: 'race' })).toThrow('WORLD_UPDATE_IN_PROGRESS');
    expect(() => services.worlds.setState(world.id, {})).toThrow('STATE_WRITE_LOCKED');
    expect(() => services.sessions.update(session.id, { title: 'race' })).toThrow('SESSION_WRITE_LOCKED');
    expect(() => services.sessions.setState(session.id, {})).toThrow('STATE_WRITE_LOCKED');
    expect(() => services.sessions.create({ worldId: world.id, userCharacterId: 'player', runtimeConfig: session.runtimeConfig })).toThrow('WORLD_UPDATE_IN_PROGRESS');
    expect(() => services.cache.acquireRun({ worldId: world.id, sessionId: session.id, runId: 'race' })).toThrow('WORLD_UPDATE_IN_PROGRESS');
    expect(() => services.cache.acquireReplyAssist(session.id, 'race', world.id)).toThrow('WORLD_UPDATE_IN_PROGRESS');
    await expect(services.worlds.openOriginal(world.id)).rejects.toThrow('WORLD_UPDATE_IN_PROGRESS');
    resume.resolve();
    await pending;
    expect(() => services.cache.assertWorldRead(world.id)).not.toThrow();
  });
});
