import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { JsonObject } from '../database/connection.js';
import { AppError } from '../errors.js';
import type { ModelService } from '../models/service.js';
import type { PresetService } from '../presets/service.js';
import { assertWorldId, exportFilename, WorldFileStore, type OriginalFormat, type PackageFile, type WorldDownload, type WorldOriginal, type WorldPaths } from './files.js';
import { WorldRepository } from './repository.js';
import {
  worldContentFields, type CreateWorld, type WorldContent, type WorldListOptions, type WorldPatch, type WorldRecord, type WorldTag,
} from './types.js';

export type { CreateWorld, WorldContent, WorldListOptions, WorldPatch, WorldRecord, WorldTag } from './types.js';
export type { OriginalFormat, PackageFile, WorldDownload, WorldOriginal, WorldPaths } from './files.js';

type WorldDependencies = { presets: PresetService; models: ModelService };
const nullableTextFields = ['description', 'cover', 'stage_component', 'default_preset_id', 'default_api_model_config_id'] as const;

function nonblank(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new AppError('INVALID_WORLD_FIELD', field);
  return value.trim();
}

function inputKeys(input: object, allowed: readonly string[]): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new AppError('INVALID_WORLD_FIELD', key);
  }
}

function tagsFrom(input: readonly string[]): string[] {
  if (!Array.isArray(input)) throw new AppError('INVALID_WORLD_TAGS');
  return [...new Set(input.map(name => nonblank(name, 'tags')))];
}

function normalizeContent(input: WorldContent): WorldContent {
  const content = { ...input, name: nonblank(input.name, 'name'), spec_version: nonblank(input.spec_version, 'spec_version') };
  for (const field of nullableTextFields) {
    const value = input[field];
    if (value === null) continue;
    if (typeof value !== 'string') throw new AppError('INVALID_WORLD_FIELD', field);
    content[field] = field === 'default_preset_id' || field === 'default_api_model_config_id' ? nonblank(value, field) : value;
  }
  return content;
}

function initialContent(input: CreateWorld): WorldContent {
  return {
    spec_version: input.spec_version,
    name: input.name,
    description: input.description ?? null,
    cover: input.cover ?? null,
    characters_json: input.characters_json,
    openings_json: input.openings_json,
    lorebook_json: input.lorebook_json ?? null,
    state_definition_json: input.state_definition_json ?? null,
    message_render_json: input.message_render_json ?? null,
    components: input.components ?? null,
    stage_component: input.stage_component ?? null,
    extensions_json: input.extensions_json ?? null,
    default_preset_id: input.default_preset_id ?? null,
    default_api_model_config_id: input.default_api_model_config_id ?? null,
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

  get(id: string): WorldRecord | null {
    return this.#repository.get(id);
  }

  require(id: string): WorldRecord {
    const world = this.get(id);
    if (!world) throw new AppError('WORLD_NOT_FOUND');
    return world;
  }

  list({ tag, limit = 50, offset = 0 }: WorldListOptions = {}): WorldRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0) {
      throw new AppError('INVALID_WORLD_PAGINATION');
    }
    return this.#repository.list({ tag: tag === undefined ? undefined : nonblank(tag, 'tag'), limit, offset });
  }

  create(input: CreateWorld): WorldRecord {
    inputKeys(input, [...worldContentFields, 'id', 'state', 'tags']);
    const id = input.id ?? randomUUID();
    assertWorldId(id);
    const content = normalizeContent(initialContent(input));
    const tags = tagsFrom(input.tags === undefined ? [] : input.tags);
    this.checkReferences(content);
    return this.#repository.create(id, content, tags, input.state === undefined ? {} : input.state);
  }

  update(id: string, patch: WorldPatch): WorldRecord | null {
    // World definition edits cannot overwrite a runtime snapshot.
    inputKeys(patch, [...worldContentFields, 'tags']);
    const current = this.get(id);
    if (!current) return null;
    const changes = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (!changes.length) return current;
    const next = normalizeContent({ ...current, ...Object.fromEntries(changes) });
    const tags = patch.tags === undefined ? undefined : tagsFrom(patch.tags);
    this.checkReferences(next);
    return this.#repository.update(id, next, tags);
  }

  setTags(id: string, tags: readonly string[]): WorldRecord | null {
    if (!Array.isArray(tags)) throw new AppError('INVALID_WORLD_TAGS');
    return this.update(id, { tags });
  }

  listTags(): WorldTag[] {
    return this.#repository.listTags();
  }

  delete(id: string): boolean {
    return this.#repository.delete(id);
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

  saveOriginal(worldId: string, format: OriginalFormat, bytes: Uint8Array): Promise<void> {
    return this.#files.saveOriginal(worldId, format, bytes);
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
    if (content.default_preset_id !== null) this.#dependencies.presets.require(content.default_preset_id);
    if (content.default_api_model_config_id !== null) this.#dependencies.models.require(content.default_api_model_config_id);
  }
}
