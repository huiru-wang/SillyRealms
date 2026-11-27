import { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { offsetPage, readOffsetPagination } from '../http/pagination.js';
import { readJson, success } from '../http/response.js';
import type { CreatePresetInput, PresetListOptions, PresetService, UpdatePresetInput } from '../modules/presets/service.js';

export function createPresetRoutes(presets: PresetService, deletePreset: (id: string) => void) {
  const routes = new Hono();

  routes.get('/default', c => {
    const type = z.enum(['narrative', 'reply_assist']).parse(c.req.query('type') ?? 'narrative');
    return success(c, { item: presets.getDefault(type) });
  });
  routes.post('/import', async c => {
    const item = presets.importDocument(await readJson(c));
    return success(c, { item }, 201);
  });
  routes.get('/:id/export', c => {
    const document = presets.toDocument(presets.require(c.req.param('id')));
    const body = JSON.stringify(document, null, 2) + '\n';
    const filename = encodeURIComponent(document.name + '.json').replace(/[!'()*]/g, value =>
      '%' + value.charCodeAt(0).toString(16).toUpperCase());
    return new Response(c.req.method === 'HEAD' ? null : body, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': "attachment; filename=\"preset.json\"; filename*=UTF-8''" + filename,
        'Content-Length': String(new TextEncoder().encode(body).byteLength),
      },
    });
  });

  routes.get('/', c => {
    const type = c.req.query('type') ?? 'narrative', scope = 'presets:' + type;
    const pagination = readOffsetPagination(c, scope, { defaultLimit: 100, maxLimit: 1000 });
    const { items, hasMore } = presets.listPage({ ...pagination, type: type as PresetListOptions['type'] });
    return success(c, offsetPage(items, hasMore, pagination, scope));
  });
  routes.get('/:id', c => success(c, { item: presets.require(c.req.param('id')) }));
  routes.post('/', async c => {
    const value = await readJson<CreatePresetInput>(c);
    return success(c, { item: presets.create(value) }, 201);
  });
  routes.patch('/:id', async c => {
    const id = c.req.param('id');
    const body = await readJson<UpdatePresetInput & { expectedRevision: number }>(c);
    const expectedRevision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(body.expectedRevision);
    const patch = { ...body };
    Reflect.deleteProperty(patch, 'expectedRevision');
    const item = presets.update(id, patch, expectedRevision);
    if (!item) throw new AppError('PRESET_NOT_FOUND');
    return success(c, { item });
  });
  routes.delete('/:id', c => {
    const id = c.req.param('id');
    deletePreset(id);
    return success(c, { id });
  });

  return routes;
}
