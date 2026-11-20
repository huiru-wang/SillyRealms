import { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { offsetPage, readOffsetPagination } from '../http/pagination.js';
import { readJson, success } from '../http/response.js';
import type { ImportPreset } from '../usecases/import-preset.js';
import type { ExportPreset } from '../usecases/export-preset.js';
import type { CreatePresetInput, PresetSummary, PresetListOptions, PresetService, UpdatePresetInput } from '../modules/presets/service.js';

function presetSummary(preset: PresetSummary) {
  return {
    id: preset.id, revision: preset.revision, type: preset.type, name: preset.name, description: preset.description,
    createdAt: preset.createdAt, updatedAt: preset.updatedAt,
  };
}

type PresetUsecases = { importPreset: ImportPreset; exportPreset: ExportPreset; deletePreset: (id: string) => void };

export function createPresetRoutes(presets: PresetService, usecases?: PresetUsecases) {
  const routes = new Hono();

  routes.get('/default', c => {
    if ((c.req.query('type') ?? 'narrative') !== 'narrative') throw new AppError('INVALID_REQUEST');
    return success(c, { item: presets.getDefault() });
  });
  routes.post('/import', async c => {
    if (!usecases) throw new AppError('SERVICE_UNAVAILABLE');
    const item = usecases.importPreset(await readJson(c));
    return success(c, { item }, 201);
  });
  routes.get('/:id/export', c => {
    if (!usecases) throw new AppError('SERVICE_UNAVAILABLE');
    const file = usecases.exportPreset(c.req.param('id'));
    const body = JSON.stringify(file.document, null, 2) + '\n';
    const filename = encodeURIComponent(file.filename).replace(/[!'()*]/g, value =>
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
    return success(c, offsetPage(items.map(presetSummary), hasMore, pagination, scope));
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
    if (!usecases) throw new AppError('SERVICE_UNAVAILABLE');
    usecases.deletePreset(id);
    return success(c, { id });
  });

  return routes;
}
