import { Hono } from 'hono';
import { getMimeType } from 'hono/utils/mime';
import { AppError } from '../errors.js';
import { numberQuery, readJson, success } from '../http/response.js';
import type { CreateWorld, WorldDownload, WorldPatch, WorldService } from '../worlds/service.js';

const mediaTypes: Record<string, string> = {
  ts: 'text/plain', tsx: 'text/plain', jsx: 'text/plain',
  wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
  m4a: 'audio/mp4', aac: 'audio/aac', mp3: 'audio/mpeg', mp4: 'video/mp4', m4v: 'video/mp4',
  mov: 'video/quicktime', ogv: 'video/ogg', webm: 'video/webm',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
};

async function fileResponse(file: WorldDownload, head: boolean, attachment = false): Promise<Response> {
  const extension = file.filename.split('.').at(-1)!.toLowerCase();
  const type = mediaTypes[extension] ?? getMimeType(file.filename) ?? 'application/octet-stream';
  const headers = new Headers({
    'Content-Type': type,
    'Content-Length': String(file.size),
    'X-Content-Type-Options': 'nosniff',
    // A package document opened directly must not become a privileged application page.
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  });
  if (attachment) headers.set('Content-Disposition', 'attachment; filename="' + file.filename + '"');
  if (head) {
    await file.body.cancel();
    return new Response(null, { headers });
  }
  return new Response(file.body, { headers });
}

export function createWorldRoutes(worlds: WorldService): Hono {
  const routes = new Hono();
  routes.get('/', c => success(c, { items: worlds.list({
    tag: c.req.query('tag'), limit: numberQuery(c, 'limit'), offset: numberQuery(c, 'offset'),
  }) }));
  routes.get('/tags', c => success(c, { items: worlds.listTags() }));
  routes.post('/', async c => success(c, { item: worlds.create(await readJson<CreateWorld>(c)) }, 201));
  routes.get('/:id/original', async c =>
    fileResponse(await worlds.openOriginal(c.req.param('id'), c.req.raw.signal), c.req.method === 'HEAD', true));
  routes.get('/:id/package/:path{.+}', async c =>
    fileResponse(await worlds.openPackageFile(c.req.param('id'), c.req.param('path'), c.req.raw.signal), c.req.method === 'HEAD'));
  routes.get('/:id', c => success(c, { item: worlds.require(c.req.param('id')) }));
  routes.patch('/:id', async c => {
    const item = worlds.update(c.req.param('id'), await readJson<WorldPatch>(c));
    if (!item) throw new AppError('WORLD_NOT_FOUND');
    return success(c, { item });
  });
  routes.delete('/:id', c => {
    const id = c.req.param('id');
    if (!worlds.delete(id)) throw new AppError('WORLD_NOT_FOUND');
    return success(c, { id });
  });
  routes.put('/:id/tags', async c => {
    const body = await readJson<{ tags: string[] }>(c);
    if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'tags')) {
      throw new AppError('INVALID_WORLD_TAGS', '请求正文必须且只能包含 tags 字段');
    }
    const item = worlds.setTags(c.req.param('id'), body.tags);
    if (!item) throw new AppError('WORLD_NOT_FOUND');
    return success(c, { item });
  });
  return routes;
}
