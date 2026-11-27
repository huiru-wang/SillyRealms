import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { getMimeType } from 'hono/utils/mime';
import { AppError } from '../errors.js';
import { decodeCursor, encodeCursor } from '../http/pagination.js';
import { numberQuery, readJson, success } from '../http/response.js';
import { readMultipart } from '../http/multipart.js';
import { requireSessionAccess, type SessionAccessCheck } from '../http/session-access.js';
import type { DeleteWorld } from '../usecases/delete-world.js';
import type { SessionService } from '../modules/sessions/service.js';
import { worldImportLimits, type World, type WorldDownload, type WorldContentDownload, type WorldManagementPatch, type WorldService } from '../modules/worlds/service.js';
import type { ImportWorld } from '../usecases/import-world.js';
import type { ExportWorld } from '../usecases/export-world.js';
import type { RuntimeCache } from '../infrastructure/cache/index.js';
import type { ApplyWorldVersionInput, WorldUpdates } from '../usecases/world-updates/index.js';

const mediaTypes: Record<string, string> = {
  ts: 'text/plain', tsx: 'text/plain', jsx: 'text/plain',
  wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
  m4a: 'audio/mp4', aac: 'audio/aac', mp3: 'audio/mpeg', mp4: 'video/mp4', m4v: 'video/mp4',
  mov: 'video/quicktime', ogv: 'video/ogg', webm: 'video/webm',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
};

function downloadDisposition(filename: string): string {
  const fallback = /^[\x20-\x7e]+$/.test(filename) ? filename.replace(/["\\\\]/g, '_') : 'world.zip';
  const base = 'attachment; filename="' + fallback + '"';
  if (fallback === filename) return base;
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  return base + "; filename*=UTF-8''" + encoded;
}

async function fileResponse(file: WorldDownload, head: boolean, attachment = false): Promise<Response> {
  const extension = file.filename.split('.').at(-1)!.toLowerCase();
  const type = mediaTypes[extension] ?? getMimeType(file.filename) ?? 'application/octet-stream';
  const headers = new Headers({
    'Content-Type': type,
    'Content-Length': String(file.size),
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*',
    // A package document opened directly must not become a privileged application page.
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  });
  if (attachment) headers.set('Content-Disposition', downloadDisposition(file.filename));
  if (head) {
    await file.body.cancel();
    return new Response(null, { headers });
  }
  return new Response(file.body, { headers });
}

function worldDetail(world: World) {
  return {
    id: world.id, revision: world.revision, specVersion: world.specVersion, publication: world.publication, name: world.name,
    presentation: world.presentation, cover: world.cover, coverMosaicEnabled: world.coverMosaicEnabled, tags: world.tags, characters: world.characters,
    openings: world.openings, lorebook: world.lorebook, stateDefinition: world.stateDefinition,
    messageRender: world.messageRender, components: world.components, stageComponent: world.stageComponent,
    extensions: world.extensions, defaultPresetId: world.defaultPresetId, defaultReplyAssistPresetId: world.defaultReplyAssistPresetId,
    defaultApiModelConfigId: world.defaultApiModelConfigId, createdAt: world.createdAt, updatedAt: world.updatedAt,
  };
}

export function createWorldRoutes({ worlds, sessions, importWorld, exportWorld, deleteWorld, worldUpdates, cache, canAccessSession, shutdownSignal }: {
  worlds: WorldService; sessions: SessionService; importWorld: ImportWorld; exportWorld: ExportWorld;
  worldUpdates: WorldUpdates; cache: RuntimeCache;
  deleteWorld: DeleteWorld; canAccessSession?: SessionAccessCheck; shutdownSignal?: AbortSignal;
}): Hono {
  const routes = new Hono();
  async function detail(world: World) {
    const epoch = cache.captureWorldRead(world.id);
    const summaries = await worldUpdates.getSummaries([world]);
    cache.assertWorldRead(world.id, epoch);
    if (worlds.require(world.id).revision !== world.revision) throw new AppError('WORLD_REVISION_CONFLICT');
    return { ...worldDetail(world), ...summaries[world.id] };
  }
  async function contentResponse(
    worldId: string, path: string, file: WorldContentDownload,
    head: boolean, ifNoneMatch: string | undefined, attachment = false,
  ): Promise<Response> {
    let world: World;
    try {
      cache.assertWorldRead(worldId, file.readEpoch);
      world = worlds.require(worldId);
      if (world.revision !== file.revision) throw new AppError('WORLD_REVISION_CONFLICT');
    } catch (error) {
      await file.body.cancel().catch(() => {});
      throw error;
    }
    const identity = JSON.stringify([world.id, world.publication.package_id,
      world.publication.release.version, world.revision, path, file.size]);
    const etag = '"' + createHash('sha256').update(identity).digest('hex') + '"';
    if (ifNoneMatch?.split(',').some(value => value.trim().replace(/^W\//, '') === etag || value.trim() === '*')) {
      await file.body.cancel();
      return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' } });
    }
    const response = await fileResponse(file, head, attachment);
    response.headers.set('ETag', etag);
    response.headers.set('Cache-Control', 'no-cache');
    return response;
  }
  routes.get('/', async c => {
    if (c.req.query('offset') !== undefined || c.req.query('tagId') !== undefined) throw new AppError('INVALID_REQUEST');
    const q = (c.req.query('q') ?? '').trim(), tag = (c.req.query('tag') ?? '').trim();
    const scope = JSON.stringify(['worlds', q, tag]);
    const cursor = c.req.query('cursor');
    let before: { createdAt: number; id: string } | undefined;
    if (cursor !== undefined) {
      const value = decodeCursor(cursor, scope);
      if (Object.keys(value).length !== 2 || !Number.isSafeInteger(value.createdAt) || Number(value.createdAt) < 0 || typeof value.id !== 'string' || !value.id) throw new AppError('INVALID_REQUEST');
      before = { createdAt: Number(value.createdAt), id: value.id };
    }
    const page = worlds.listPage({ q, tag: tag || undefined, before, limit: numberQuery(c, 'limit') ?? 24 });
    const counts = sessions.countByWorldIds(page.items.map(world => world.id));
    const summaries = await worldUpdates.getSummaries(page.items);
    const items = page.items.map(world => ({ ...world, ...summaries[world.id], sessionCount: counts[world.id] ?? 0 }));
    const last = items.at(-1);
    return success(c, { items, hasMore: page.hasMore, nextCursor: page.hasMore && last ? encodeCursor(scope, { createdAt: last.createdAt, id: last.id }) : null });
  });
  routes.get('/tags', c => success(c, { items: worlds.listTags() }));
  routes.post('/import', async c => {
    if (!c.req.header('content-type')?.toLowerCase().startsWith('multipart/form-data')) {
      throw new AppError('INVALID_REQUEST', '世界导入需要 multipart/form-data');
    }
    const body = await readMultipart(c.req.raw, worldImportLimits.zip + 1024 * 1024);
    const file = body.get('file');
    if (!(file instanceof File) || body.getAll('file').length !== 1) {
      throw new AppError('INVALID_REQUEST', '需要一个 file 文件字段');
    }
    const extension = file.name.split('.').at(-1)?.toLowerCase();
    if (extension !== 'json' && extension !== 'zip') throw new AppError('INVALID_WORLD_ORIGINAL_FORMAT');
    if (file.size > worldImportLimits[extension]) throw new AppError('PAYLOAD_TOO_LARGE');
    const world = await importWorld({ format: extension, bytes: new Uint8Array(await file.arrayBuffer()) });
    return success(c, { item: await detail(world) }, 201);
  });
  routes.get('/:id/export', async c => {
    const response = await fileResponse(await exportWorld(c.req.param('id'), c.req.raw.signal), c.req.method === 'HEAD', true);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  });
  routes.get('/:id/original', async c =>
    contentResponse(c.req.param('id'), 'original', await worlds.openOriginal(c.req.param('id'), c.req.raw.signal),
      c.req.method === 'HEAD', c.req.header('if-none-match'), true));
  routes.get('/:id/resources/:path{.+}', async c =>
    contentResponse(c.req.param('id'), c.req.param('path'), await worlds.openPackageFile(c.req.param('id'), c.req.param('path'), c.req.raw.signal),
      c.req.method === 'HEAD', c.req.header('if-none-match')));
  routes.get('/:id/components', async c => {
    const id = c.req.param('id'), epoch = cache.captureWorldRead(id), revision = worlds.require(id).revision;
    const components = await worlds.getComponents(id);
    cache.assertWorldRead(id, epoch);
    if (worlds.require(id).revision !== revision) throw new AppError('WORLD_REVISION_CONFLICT');
    c.header('Cache-Control', 'no-cache');
    return success(c, components);
  });
  routes.get('/:id/versions', async c => {
    c.header('Cache-Control', 'no-store');
    return success(c, { item: await worldUpdates.getVersions(c.req.param('id')) });
  });
  routes.post('/:id/versions/refresh', async c => {
    return success(c, { item: await worldUpdates.refresh(c.req.param('id')) });
  });
  routes.post('/:id/apply-version', async c => {
    const world = await worldUpdates.applyVersion(c.req.param('id'), await readJson<ApplyWorldVersionInput>(c));
    return success(c, { item: await detail(world) });
  });
  routes.get('/:id', async c => {
    c.header('Cache-Control', 'no-cache');
    return success(c, { item: await detail(worlds.require(c.req.param('id'))) });
  });
  routes.patch('/:id', async c => {
    const item = worlds.updateManagement(c.req.param('id'), await readJson<WorldManagementPatch>(c));
    if (!item) throw new AppError('WORLD_NOT_FOUND');
    return success(c, { item: await detail(item) });
  });
  routes.delete('/:id', async c => {
    const raw = c.req.query('deleteSessions');
    if (raw !== undefined && raw !== 'false' && raw !== 'true') {
      throw new AppError('INVALID_REQUEST', 'deleteSessions 必须为 true 或 false');
    }
    const id = c.req.param('id');
    const authorizeSession = canAccessSession
      ? (sessionId: string) => requireSessionAccess(sessions, sessionId, c.req.raw, canAccessSession, shutdownSignal)
      : undefined;
    if (!await deleteWorld(id, { deleteSessions: raw === 'true', authorizeSession })) throw new AppError('WORLD_NOT_FOUND');
    return success(c, { id });
  });
  return routes;
}
