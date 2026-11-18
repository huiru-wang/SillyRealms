import { Hono } from 'hono';
import { AppError } from '../errors.js';
import { numberQuery, readJson, success } from '../http/response.js';
import type { CreatePresetInput, PresetListOptions, PresetService, UpdatePresetInput } from '../presets/service.js';

export function createPresetRoutes(presets: PresetService) {
  const routes = new Hono();

  routes.get('/', c => success(c, { items: presets.list({
    type: c.req.query('type') as PresetListOptions['type'],
    limit: numberQuery(c, 'limit'),
    offset: numberQuery(c, 'offset'),
  }) }));
  routes.get('/:id', c => success(c, { item: presets.require(c.req.param('id')) }));
  routes.post('/', async c => {
    const item = presets.create(await readJson<CreatePresetInput>(c));
    return success(c, { item }, 201);
  });
  routes.patch('/:id', async c => {
    const item = presets.update(c.req.param('id'), await readJson<UpdatePresetInput>(c));
    if (!item) throw new AppError('PRESET_NOT_FOUND');
    return success(c, { item });
  });
  routes.delete('/:id', c => {
    const id = c.req.param('id');
    if (!presets.delete(id)) throw new AppError('PRESET_NOT_FOUND');
    return success(c, { id });
  });

  return routes;
}
