import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { JsonObject, JsonValue } from '../../infrastructure/database/connection.js';
import type { RuntimeCache, WorldUpdatePermit } from '../../infrastructure/cache/index.js';
import { AppError } from '../../errors.js';
import type { ModelReader } from '../models/service.js';
import type { PresetReader } from '../presets/service.js';
import { assertWorldId, exportFilename, WORLD_JSON_LIMIT, WORLD_ZIP_LIMIT, WorldFileStore, type OriginalFormat, type PackageFile, type ImportFileStage, type WorldDownload, type WorldOriginal, type WorldPaths, type ReleaseIndexSnapshot } from './files.js';
import { cardToWorld, worldToCard } from './parser.js';
import { openingSchema, validateCharacters, validateWorldExtensions, validateWorldStateDefinition, validateWorldPublication } from './validation.js';
import { readComponents } from './assets.js';
import { buildWorldPackage, readImportPackage } from './archive.js';
import { assertWorldReplacementCompatible } from './update-validation.js';
import { WorldRepository, type WorldContentRow, type WorldRow } from './repository.js';
import {
  worldContentFields, type CreateWorld, type WorldContent, type WorldListOptions, type WorldPatch, type World, type WorldPage, type WorldTag, type WorldManagementPatch, type CharacterSpriteCatalog, type WorldUpdateSource,
} from './types.js';

export type WorldOpening = z.infer<typeof openingSchema>;
export type { CreateWorld, WorldContent, WorldPresentation, WorldListOptions, WorldPage, WorldPatch, World, WorldTag, WorldSummary, WorldDetail, WorldManagementPatch, CharacterSpriteCatalog, CharacterSpriteCatalogItem, WorldPublication, WorldUpdateSource } from './types.js';
export type { OriginalFormat, PackageFile, WorldDownload, WorldOriginal, WorldPaths, ReleaseIndexSnapshot } from './files.js';

export { assertWorldReplacementCompatible } from './update-validation.js';
export { validateWorldPublication } from './validation.js';

export type WorldContentDownload = WorldDownload & { revision: number; readEpoch: number };
type WorldReadSnapshot = World & { readEpoch: number };
export type WorldReplacementOptions = {
  expectedRevision: number;
  packageId: string;
  updateUrl: string;
  playerCharacterIds: readonly string[];
  permit: WorldUpdatePermit;
  guard?: (snapshot: ReleaseIndexSnapshot | null) => void;
};

export interface WorldReader {
  get(id: string): World | null;
  require(id: string): World;
  getState(worldId: string): JsonObject | null;
  getCharacterSpriteCatalog(worldId: string): CharacterSpriteCatalog;
}
export const worldImportLimits = { json: WORLD_JSON_LIMIT, zip: WORLD_ZIP_LIMIT } as const;
export type WorldImportInput = { format: OriginalFormat; bytes: Uint8Array };
export type PreparedWorldImport = Readonly<{ id: string; content: CreateWorld }>;
export type { WorldCard } from './validation.js';
export { inspectWorldSource, prepareWorldSourcePackage } from './authoring.js';
export type { WorldSourceInspection, PreparedWorldSourcePackage } from './authoring.js';

type WorldDependencies = { presets: PresetReader; models: ModelReader; cache: RuntimeCache };
const nullableTextFields = ['cover', 'stageComponent', 'defaultPresetId', 'defaultReplyAssistPresetId', 'defaultApiModelConfigId'] as const;

function nonblank(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new AppError('INVALID_WORLD_FIELD', field);
  return value.trim();
}

function inputKeys(input: object, allowed: readonly string[]): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('INVALID_WORLD_FIELD');
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new AppError('INVALID_WORLD_FIELD', key);
  }
}

function tagsFrom(input: readonly string[]): string[] {
  if (!Array.isArray(input)) throw new AppError('INVALID_WORLD_TAGS');
  return [...new Set(input.map(name => nonblank(name, 'tags')))];
}

function normalizeContent(input: WorldContent): WorldContent {
  const content = { ...input, name: nonblank(input.name, 'name'), specVersion: nonblank(input.specVersion, 'specVersion') };
  for (const field of nullableTextFields) {
    const value = input[field];
    if (value === null) continue;
    if (typeof value !== 'string') throw new AppError('INVALID_WORLD_FIELD', field);
    content[field] = field === 'defaultPresetId' || field === 'defaultReplyAssistPresetId' || field === 'defaultApiModelConfigId' ? nonblank(value, field) : value;
  }
  content.publication = validateWorldPublication(content.publication);
  if (content.specVersion !== '0.2') throw new AppError('INVALID_WORLD_CARD', 'Unsupported world card format');
  if (content.extensions !== null) validateWorldExtensions(content.extensions);
  return content;
}

function initialContent(input: CreateWorld): WorldContent {
  return {
    specVersion: input.specVersion,
    publication: input.publication,
    name: input.name,
    presentation: input.presentation ?? null,
    cover: input.cover ?? null,
    characters: input.characters,
    openings: input.openings,
    lorebook: input.lorebook ?? null,
    stateDefinition: input.stateDefinition ?? null,
    messageRender: input.messageRender ?? null,
    components: input.components ?? null,
    stageComponent: input.stageComponent ?? null,
    extensions: input.extensions ?? null,
    defaultPresetId: input.defaultPresetId ?? null,
    defaultReplyAssistPresetId: input.defaultReplyAssistPresetId ?? null,
    defaultApiModelConfigId: input.defaultApiModelConfigId ?? null,
  };
}

function coverMosaicEnabled(extensions: JsonValue): boolean {
  return extensions !== null && typeof extensions === 'object' && !Array.isArray(extensions) && extensions.cover_mosaic_enabled === true;
}

function withCoverMosaic(extensions: JsonValue, enabled: boolean): JsonObject {
  const current = extensions ?? {};
  validateWorldExtensions(current);
  return { ...current, cover_mosaic_enabled: enabled };
}

function toWorld(row: WorldRow): World {
  return {
    id: row.id, revision: row.revision, coverMosaicEnabled: coverMosaicEnabled(row.extensions_json), specVersion: row.spec_version, publication: row.publication_json, name: row.name, presentation: row.presentation_json, cover: row.cover,
    characters: row.characters_json, openings: row.openings_json, lorebook: row.lorebook_json,
    stateDefinition: row.state_definition_json, messageRender: row.message_render_json,
    components: row.components, stageComponent: row.stage_component, extensions: row.extensions_json,
    defaultPresetId: row.default_preset_id, defaultReplyAssistPresetId: row.default_reply_assist_preset_id, defaultApiModelConfigId: row.default_api_model_config_id,
    state: row.state, tags: row.tags, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function toContentRow(content: WorldContent): WorldContentRow {
  return {
    spec_version: content.specVersion, publication_json: content.publication, name: content.name, presentation_json: content.presentation, cover: content.cover,
    characters_json: content.characters, openings_json: content.openings, lorebook_json: content.lorebook,
    state_definition_json: content.stateDefinition, message_render_json: content.messageRender,
    components: content.components, stage_component: content.stageComponent, extensions_json: content.extensions,
    default_preset_id: content.defaultPresetId, default_reply_assist_preset_id: content.defaultReplyAssistPresetId, default_api_model_config_id: content.defaultApiModelConfigId,
  };
}

/** Public world operations. Other modules use this service, never world storage directly. */
export class WorldService {
  readonly #repository: WorldRepository;
  readonly #files: WorldFileStore;
  readonly #dependencies: WorldDependencies;
  readonly #imports = new WeakMap<PreparedWorldImport, ImportFileStage>();

  constructor(db: DatabaseSync, dependencies: WorldDependencies, dataRoot: string) {
    this.#repository = new WorldRepository(db);
    this.#files = new WorldFileStore(dataRoot);
    this.#dependencies = dependencies;
  }

  get(id: string): World | null {
    const row = this.#repository.get(id);
    return row ? toWorld(row) : null;
  }

  require(id: string): World {
    const world = this.get(id);
    if (!world) throw new AppError('WORLD_NOT_FOUND');
    return world;
  }

  getCharacterSpriteCatalog(worldId: string): CharacterSpriteCatalog {
    this.#dependencies.cache.assertWorldRead(worldId);
    const world = this.require(worldId);
    const characters = validateCharacters(world.characters);
    return {
      worldId,
      items: characters.flatMap(character => (character.sprites ?? []).map(sprite => ({
        characterId: character.id,
        characterName: character.name,
        spriteId: sprite.id,
        description: sprite.description,
        asset: sprite.asset,
      }))),
    };
  }

  listUpdateSources(): WorldUpdateSource[] {
    return this.#repository.listUpdateSources();
  }

  readReleaseIndex(worldId: string): Promise<ReleaseIndexSnapshot | null> {
    assertWorldId(worldId);
    if (!this.#repository.exists(worldId)) return Promise.resolve(null);
    return this.#files.readReleaseIndex(worldId);
  }

  saveReleaseIndex(
    worldId: string,
    input: { packageId: string; updateUrl: string; text: string },
    isCurrent: () => boolean,
  ): Promise<ReleaseIndexSnapshot | null> {
    return this.#files.saveReleaseIndex(worldId, input.text, () => {
      const current = this.get(worldId);
      return current?.publication.package_id === input.packageId &&
        current.publication.update_url === input.updateUrl && isCurrent();
    });
  }

  listUsingDefaultPreset(presetId: string, type: 'narrative' | 'reply_assist' = 'narrative') {
    return this.#repository.listUsingDefaultPreset(presetId, type);
  }

  list(options: WorldListOptions = {}): World[] {
    return this.#repository.list(this.listOptions(options)).map(toWorld);
  }

  listPage(options: WorldListOptions = {}): WorldPage {
    const pagination = this.listOptions(options);
    const items = this.#repository.listSummaries({ ...pagination, limit: pagination.limit + 1 });
    return { items: items.slice(0, pagination.limit).map(row => ({ id: row.id, name: row.name, publication: row.publication, cover: row.cover, coverMosaicEnabled: row.cover_mosaic_enabled, tags: row.tags, createdAt: row.created_at, updatedAt: row.updated_at })), hasMore: items.length > pagination.limit };
  }

  private listOptions(options: WorldListOptions) {
    const result = z.object({
      q: z.string().trim().max(200).optional(), tag: z.string().trim().min(1).optional(),
      limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 201).default(0),
      before: z.object({ createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), id: z.string().min(1) }).strict().optional(),
    }).strict().safeParse(options);
    if (!result.success) throw new AppError('INVALID_WORLD_PAGINATION');
    return result.data;
  }

  updateManagement(id: string, input: WorldManagementPatch): World {
    this.#dependencies.cache.assertWorldWrite(id);
    const value = z.object({
      name: z.string().trim().min(1).optional(), tags: z.array(z.string().trim().min(1)).optional(),
      coverMosaicEnabled: z.boolean().optional(),
      defaultPresetId: z.string().trim().min(1).nullable().optional(),
      defaultReplyAssistPresetId: z.string().trim().min(1).nullable().optional(),
      defaultApiModelConfigId: z.string().trim().min(1).nullable().optional(),
      expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    }).strict().refine(value => Object.keys(value).length > 1, '更新不能为空').parse(input);
    const current = this.require(id);
    if (current.revision !== value.expectedRevision) throw new AppError('WORLD_REVISION_CONFLICT');
    this.checkReferences({ ...current, ...value });
    const patch = {
      ...(value.name !== undefined ? { name: value.name } : {}),
      ...(value.coverMosaicEnabled !== undefined ? { extensions_json: withCoverMosaic(current.extensions, value.coverMosaicEnabled) } : {}),
      ...(value.defaultPresetId !== undefined ? { default_preset_id: value.defaultPresetId } : {}),
      ...(value.defaultReplyAssistPresetId !== undefined ? { default_reply_assist_preset_id: value.defaultReplyAssistPresetId } : {}),
      ...(value.defaultApiModelConfigId !== undefined ? { default_api_model_config_id: value.defaultApiModelConfigId } : {}),
    };
    const row = this.#repository.updateManagement(id, patch, value.tags === undefined ? undefined : tagsFrom(value.tags), value.expectedRevision);
    if (!row) throw new AppError('WORLD_REVISION_CONFLICT');
    return toWorld(row);
  }

  async getComponents(id: string) {
    const world = this.captureRead(id);
    const result = await readComponents(world.components ?? [], path => this.#files.resolvePackageFile(id, path))
      .catch(error => this.failRead(world, error));
    this.assertRead(world);
    return result;
  }

  create(input: CreateWorld): World {
    inputKeys(input, [...worldContentFields, 'id', 'state', 'tags']);
    const id = input.id ?? randomUUID();
    assertWorldId(id);
    this.#dependencies.cache.assertWorldWrite(id);
    const content = normalizeContent(initialContent(input));
    const tags = tagsFrom(input.tags === undefined ? [] : input.tags);
    worldToCard({ ...content, tags });
    this.checkReferences(content);
    return toWorld(this.#repository.create(id, toContentRow(content), tags, input.state === undefined ? {} : input.state));
  }

  update(id: string, patch: WorldPatch): World | null {
    this.#dependencies.cache.assertWorldWrite(id);
    // World definition edits cannot overwrite a runtime snapshot.
    inputKeys(patch, [...worldContentFields, 'tags']);
    const current = this.get(id);
    if (!current) return null;
    const changes = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (!changes.length) return current;
    const next = normalizeContent({ ...current, ...Object.fromEntries(changes) });
    // Source changes require a future queued cache invalidation operation.
    if (current.publication.package_id !== next.publication.package_id ||
      current.publication.update_url !== next.publication.update_url) throw new AppError('WORLD_UPDATE_SOURCE_CHANGED');
    if (patch.stateDefinition != null) validateWorldStateDefinition(patch.stateDefinition);
    if (patch.characters !== undefined) next.characters = validateCharacters(patch.characters);
    const tags = patch.tags === undefined ? undefined : tagsFrom(patch.tags);
    worldToCard({ ...next, tags: tags ?? current.tags });
    this.checkReferences(next);
    return toWorld(this.#repository.update(id, toContentRow(next), tags));
  }

  listTags(): WorldTag[] {
    return this.#repository.listTags().map(row => ({ name: row.name, worldCount: row.world_count }));
  }

  deleteRecord(id: string): boolean {
    assertWorldId(id);
    this.#dependencies.cache.assertWorldWrite(id);
    return this.#repository.delete(id);
  }

  async deleteFiles(id: string): Promise<boolean> {
    assertWorldId(id);
    this.#dependencies.cache.assertWorldWrite(id);
    try {
      return await this.#files.remove(id);
    } catch {
      // Retrying also cleans up a directory whose DB row was already deleted.
      throw new AppError('WORLD_FILES_DELETE_FAILED');
    }
  }

  /** Single-world cleanup used by import compensation; management deletion is a usecase. */
  async delete(id: string): Promise<boolean> {
    const dbDeleted = this.deleteRecord(id);
    const filesRemoved = await this.deleteFiles(id);
    return dbDeleted || filesRemoved;
  }

  requireOpening(worldId: string, openingId: string): WorldOpening {
    const world = this.require(worldId);
    const raw = world.openings.find(item => item !== null && typeof item === 'object' && !Array.isArray(item) && item.id === openingId);
    if (raw === undefined) throw new AppError('INVALID_SESSION_OPENING');
    const result = openingSchema.safeParse(raw);
    if (!result.success) throw new AppError('INVALID_WORLD_CARD', '开局结构无效');
    return result.data;
  }

  getState(worldId: string): JsonObject | null {
    assertWorldId(worldId);
    return this.#repository.getState(worldId);
  }

  /** Snapshot persistence only; state definitions and update rules belong to StateService. */
  setState(worldId: string, value: JsonObject): JsonObject {
    assertWorldId(worldId);
    this.#dependencies.cache.assertGlobalStateWrite(worldId);
    const state = this.#repository.setState(worldId, value);
    if (state === null) throw new AppError('WORLD_NOT_FOUND');
    return state;
  }

  paths(worldId: string): WorldPaths {
    return this.#files.paths(worldId);
  }

  async saveOriginal(worldId: string, format: OriginalFormat, bytes: Uint8Array): Promise<void> {
    this.#dependencies.cache.assertWorldWrite(worldId);
    const revision = this.require(worldId).revision;
    await this.#files.saveOriginal(worldId, format, bytes, () => {
      this.#dependencies.cache.assertWorldWrite(worldId);
      const current = this.get(worldId);
      if (current && current.revision !== revision) throw new AppError('WORLD_REVISION_CONFLICT');
    });
  }

  async readOriginal(worldId: string): Promise<WorldOriginal | null> {
    const readEpoch = this.#dependencies.cache.captureWorldRead(worldId);
    const world = this.get(worldId);
    if (!world) return null;
    const snapshot = { ...world, readEpoch };
    const result = await this.#files.readOriginal(worldId).catch(error => this.failRead(snapshot, error));
    this.assertRead(snapshot);
    return result;
  }

  async resolvePackageFile(worldId: string, relativePath: string): Promise<PackageFile & { revision: number; readEpoch: number }> {
    const world = this.captureRead(worldId);
    const file = await this.#files.resolvePackageFile(worldId, relativePath).catch(error => this.failRead(world, error));
    this.assertRead(world);
    return { ...file, revision: world.revision, readEpoch: world.readEpoch };
  }

  async openOriginal(worldId: string, signal?: AbortSignal): Promise<WorldContentDownload> {
    const world = this.captureRead(worldId);
    const download = await this.#files.openOriginal(worldId, signal).catch(error => this.failRead(world, error));
    if (!download) {
      this.assertRead(world);
      throw new AppError('WORLD_ORIGINAL_NOT_FOUND');
    }
    return this.checkedDownload(world, download);
  }

  async openPackageFile(worldId: string, relativePath: string, signal?: AbortSignal): Promise<WorldContentDownload> {
    const world = this.captureRead(worldId);
    const download = await this.#files.openPackageFile(worldId, relativePath, signal).catch(error => this.failRead(world, error));
    return this.checkedDownload(world, download);
  }

  exportFilename(worldName: string): string {
    return exportFilename(worldName);
  }

  async prepareImport(input: WorldImportInput, id: string = randomUUID()): Promise<PreparedWorldImport> {
    let files: ImportFileStage;
    try { files = await this.#files.stageImport(id, input.format, input.bytes); }
    catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('WORLD_IMPORT_FAILED');
    }
    try {
      const card = await readImportPackage(files);
      const stage = Object.freeze({ id, content: cardToWorld(card) });
      this.#imports.set(stage, files);
      return stage;
    } catch (error) {
      try { await this.#files.discardImport(files); }
      catch { throw new AppError('WORLD_IMPORT_CLEANUP_FAILED'); }
      if (error instanceof AppError) throw error;
      throw new AppError('WORLD_IMPORT_FAILED');
    }
  }

  async publishImport(stage: PreparedWorldImport): Promise<void> {
    const files = this.importFiles(stage);
    this.#dependencies.cache.assertWorldWrite(stage.id);
    if (this.get(stage.id)) throw new AppError('RESOURCE_CONFLICT');
    try { await this.#files.publishImport(files); }
    catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('WORLD_IMPORT_FAILED');
    }
  }

  /** Files and the world-only CAS commit share one filesystem serialization interval. */
  async applyPreparedReplacement(stage: PreparedWorldImport, options: WorldReplacementOptions): Promise<World> {
    const files = this.importFiles(stage);
    if (files.published) throw new AppError('INVALID_REQUEST', '替换必须使用独立暂存包');
    const incoming = normalizeContent(initialContent(stage.content));
    worldToCard({ ...incoming, tags: stage.content.tags ?? [] });
    const current = (snapshot: ReleaseIndexSnapshot | null): World => {
      this.#dependencies.cache.assertWorldWrite(stage.id, options.permit);
      const world = this.require(stage.id);
      if (world.revision !== options.expectedRevision) throw new AppError('WORLD_REVISION_CONFLICT');
      if (world.publication.package_id !== options.packageId ||
        world.publication.update_url !== options.updateUrl) throw new AppError('WORLD_UPDATE_SOURCE_CHANGED');
      assertWorldReplacementCompatible(world, incoming, options.playerCharacterIds);
      if (world.publication.release.version === incoming.publication.release.version) {
        throw new AppError('WORLD_UPDATE_INCOMPATIBLE', '不能覆盖为当前发行版本');
      }
      options.guard?.(snapshot);
      return world;
    };
    // replaceImport now owns cleanup; never let ordinary discard delete a recovery backup.
    this.#imports.delete(stage);
    try {
      return await this.#files.replaceImport(files, snapshot => { current(snapshot); }, snapshot => {
        const world = current(snapshot);
        const content: WorldContent = {
          ...incoming,
          name: world.name,
          defaultPresetId: world.defaultPresetId,
          defaultReplyAssistPresetId: world.defaultReplyAssistPresetId,
          defaultApiModelConfigId: world.defaultApiModelConfigId,
          extensions: withCoverMosaic(incoming.extensions, world.coverMosaicEnabled),
          publication: { ...incoming.publication!, update_url: options.updateUrl },
        };
        const row = this.#repository.replaceContent(stage.id, toContentRow(content), options.expectedRevision);
        if (!row) throw new AppError('WORLD_REVISION_CONFLICT');
        return toWorld(row);
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('WORLD_UPDATE_REPLACE_FAILED');
    }
  }

  async discardImport(stage: PreparedWorldImport): Promise<void> {
    const files = this.#imports.get(stage);
    if (!files) return;
    // A failed import must never remove a different or already-persisted world.
    if (files.published && this.get(stage.id)) throw new AppError('WORLD_IMPORT_CLEANUP_FAILED');
    try {
      await this.#files.discardImport(files);
      this.#imports.delete(stage);
    } catch { throw new AppError('WORLD_IMPORT_CLEANUP_FAILED'); }
  }

  finishImport(stage: PreparedWorldImport): void {
    this.#imports.delete(stage);
  }

  private importFiles(stage: PreparedWorldImport): ImportFileStage {
    const files = this.#imports.get(stage);
    if (!files) throw new AppError('INVALID_REQUEST', '世界导入暂存句柄无效');
    return files;
  }

  async buildExport(world: World, signal?: AbortSignal): Promise<WorldContentDownload> {
    const snapshot = { ...world, readEpoch: this.#dependencies.cache.captureWorldRead(world.id) };
    this.assertRead(snapshot);
    const card = worldToCard(world);
    try {
      const exported = await buildWorldPackage(this.#files, world.id, card);
      try {
        this.assertRead(snapshot);
        const download = await this.#files.openExport(exported.path, this.exportFilename(world.name), exported.cleanup, signal);
        return await this.checkedDownload(snapshot, download);
      } catch (error) { await exported.cleanup(); throw error; }
    } catch (error) {
      this.assertRead(snapshot);
      if (error instanceof AppError) throw error;
      throw new AppError('WORLD_EXPORT_FAILED');
    }
  }

  private captureRead(id: string): WorldReadSnapshot {
    const readEpoch = this.#dependencies.cache.captureWorldRead(id);
    return { ...this.require(id), readEpoch };
  }

  private assertRead(world: Pick<WorldReadSnapshot, 'id' | 'revision' | 'readEpoch'>): void {
    this.#dependencies.cache.assertWorldRead(world.id, world.readEpoch);
    if (this.require(world.id).revision !== world.revision) throw new AppError('WORLD_REVISION_CONFLICT');
  }

  private failRead(world: WorldReadSnapshot, error: unknown): never {
    this.assertRead(world);
    throw error;
  }

  private async checkedDownload(world: WorldReadSnapshot, download: WorldDownload): Promise<WorldContentDownload> {
    try {
      this.assertRead(world);
      return { ...download, revision: world.revision, readEpoch: world.readEpoch };
    } catch (error) {
      await download.body.cancel().catch(() => {});
      throw error;
    }
  }

  private checkReferences(content: WorldContent): void {
    if (content.defaultPresetId !== null) this.#dependencies.presets.require(content.defaultPresetId, 'narrative');
    if (content.defaultReplyAssistPresetId !== null) this.#dependencies.presets.require(content.defaultReplyAssistPresetId, 'reply_assist');
    if (content.defaultApiModelConfigId !== null) this.#dependencies.models.require(content.defaultApiModelConfigId);
  }
}
