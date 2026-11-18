import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { JsonObject } from '../database/connection.js';
import { AppError } from '../errors.js';
import type { ModelService } from '../models/service.js';
import type { PresetService } from '../presets/service.js';
import { assertWorldId, exportFilename, WorldFileStore, type OriginalFormat, type PackageFile, type WorldDownload, type WorldOriginal, type WorldPaths } from './files.js';
import { WorldRepository, type WorldContentRow, type WorldRow } from './repository.js';
import {
  worldContentFields, type CreateWorld, type WorldContent, type WorldListOptions, type WorldPatch, type World, type WorldPage, type WorldTag,
} from './types.js';

export type { CreateWorld, WorldContent, WorldDescription, WorldListOptions, WorldPage, WorldPatch, World, WorldTag } from './types.js';
export type { OriginalFormat, PackageFile, WorldDownload, WorldOriginal, WorldPaths } from './files.js';

type WorldDependencies = { presets: PresetService; models: ModelService };
const nullableTextFields = ['cover', 'stageComponent', 'defaultPresetId', 'defaultApiModelConfigId'] as const;

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
    content[field] = field === 'defaultPresetId' || field === 'defaultApiModelConfigId' ? nonblank(value, field) : value;
  }
  const description = input.description;
  if (description !== null && typeof description !== 'string') {
    if (typeof description !== 'object' || Array.isArray(description) ||
      Object.keys(description).some(key => key !== 'type' && key !== 'component') || description.type !== 'component') {
      throw new AppError('INVALID_WORLD_FIELD', 'description');
    }
    content.description = { type: 'component', component: nonblank(description.component, 'description.component') };
  }
  return content;
}

function initialContent(input: CreateWorld): WorldContent {
  return {
    specVersion: input.specVersion,
    name: input.name,
    description: input.description ?? null,
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
    defaultApiModelConfigId: input.defaultApiModelConfigId ?? null,
  };
}

function toWorld(row: WorldRow): World {
  return {
    id: row.id, specVersion: row.spec_version, name: row.name, description: row.description, cover: row.cover,
    characters: row.characters_json, openings: row.openings_json, lorebook: row.lorebook_json,
    stateDefinition: row.state_definition_json, messageRender: row.message_render_json,
    components: row.components, stageComponent: row.stage_component, extensions: row.extensions_json,
    defaultPresetId: row.default_preset_id, defaultApiModelConfigId: row.default_api_model_config_id,
    state: row.state, tags: row.tags, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function toContentRow(content: WorldContent): WorldContentRow {
  return {
    spec_version: content.specVersion, name: content.name, description: content.description, cover: content.cover,
    characters_json: content.characters, openings_json: content.openings, lorebook_json: content.lorebook,
    state_definition_json: content.stateDefinition, message_render_json: content.messageRender,
    components: content.components, stage_component: content.stageComponent, extensions_json: content.extensions,
    default_preset_id: content.defaultPresetId, default_api_model_config_id: content.defaultApiModelConfigId,
  };
}

/** Public world operations. Other modules use this service, never world storage directly. */
export class WorldService {
  readonly #repository: WorldRepository;
  readonly #files: WorldFileStore;
  readonly #dependencies: WorldDependencies;

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

  list(options: WorldListOptions = {}): World[] {
    return this.#repository.list(this.listOptions(options)).map(toWorld);
  }

  listPage(options: WorldListOptions = {}): WorldPage {
    const pagination = this.listOptions(options);
    const items = this.#repository.list({ ...pagination, limit: pagination.limit + 1 });
    return { items: items.slice(0, pagination.limit).map(toWorld), hasMore: items.length > pagination.limit };
  }

  private listOptions({ tag, limit = 50, offset = 0 }: WorldListOptions) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) ||
      offset < 0 || !Number.isSafeInteger(offset + limit)) {
      throw new AppError('INVALID_WORLD_PAGINATION');
    }
    return { tag: tag === undefined ? undefined : nonblank(tag, 'tag'), limit, offset };
  }

  create(input: CreateWorld): World {
    inputKeys(input, [...worldContentFields, 'id', 'state', 'tags']);
    const id = input.id ?? randomUUID();
    assertWorldId(id);
    const content = normalizeContent(initialContent(input));
    const tags = tagsFrom(input.tags === undefined ? [] : input.tags);
    this.checkReferences(content);
    return toWorld(this.#repository.create(id, toContentRow(content), tags, input.state === undefined ? {} : input.state));
  }

  update(id: string, patch: WorldPatch): World | null {
    // World definition edits cannot overwrite a runtime snapshot.
    inputKeys(patch, [...worldContentFields, 'tags']);
    const current = this.get(id);
    if (!current) return null;
    const changes = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (!changes.length) return current;
    const next = normalizeContent({ ...current, ...Object.fromEntries(changes) });
    const tags = patch.tags === undefined ? undefined : tagsFrom(patch.tags);
    this.checkReferences(next);
    return toWorld(this.#repository.update(id, toContentRow(next), tags));
  }

  setTags(id: string, tags: readonly string[]): World | null {
    if (!Array.isArray(tags)) throw new AppError('INVALID_WORLD_TAGS');
    return this.update(id, { tags });
  }

  listTags(): WorldTag[] {
    return this.#repository.listTags().map(row => ({ name: row.name, worldCount: row.world_count }));
  }

  async delete(id: string): Promise<boolean> {
    assertWorldId(id);
    // A rejected DB deletion must never remove the still-referenced world's files.
    const dbDeleted = this.#repository.delete(id);
    try {
      const filesRemoved = await this.#files.remove(id);
      return dbDeleted || filesRemoved;
    } catch {
      // Retrying also cleans up a directory whose DB row was already deleted.
      throw new AppError('WORLD_FILES_DELETE_FAILED');
    }
  }

  getState(worldId: string): JsonObject | null {
    assertWorldId(worldId);
    return this.#repository.getState(worldId);
  }

  /** Snapshot persistence only; state definitions and update rules belong to StateService. */
  setState(worldId: string, value: JsonObject): JsonObject {
    assertWorldId(worldId);
    const state = this.#repository.setState(worldId, value);
    if (state === null) throw new AppError('WORLD_NOT_FOUND');
    return state;
  }

  paths(worldId: string): WorldPaths {
    return this.#files.paths(worldId);
  }

  async saveOriginal(worldId: string, format: OriginalFormat, bytes: Uint8Array): Promise<void> {
    this.require(worldId);
    await this.#files.saveOriginal(worldId, format, bytes);
  }

  readOriginal(worldId: string): Promise<WorldOriginal | null> {
    return this.#files.readOriginal(worldId);
  }

  resolvePackageFile(worldId: string, relativePath: string): Promise<PackageFile> {
    return this.#files.resolvePackageFile(worldId, relativePath);
  }

  async openOriginal(worldId: string, signal?: AbortSignal): Promise<WorldDownload> {
    this.require(worldId);
    const download = await this.#files.openOriginal(worldId, signal);
    if (!download) throw new AppError('WORLD_ORIGINAL_NOT_FOUND');
    return download;
  }

  openPackageFile(worldId: string, relativePath: string, signal?: AbortSignal): Promise<WorldDownload> {
    this.require(worldId);
    return this.#files.openPackageFile(worldId, relativePath, signal);
  }

  exportFilename(worldName: string): string {
    return exportFilename(worldName);
  }

  private checkReferences(content: WorldContent): void {
    if (content.defaultPresetId !== null) this.#dependencies.presets.require(content.defaultPresetId);
    if (content.defaultApiModelConfigId !== null) this.#dependencies.models.require(content.defaultApiModelConfigId);
  }
}
