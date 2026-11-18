import { Hono } from 'hono';
import { AppError } from '../errors.js';
import { numberQuery, readJson, success } from '../http/response.js';
import type { CreateModelInput, ModelService, UpdateModelInput } from '../models/service.js';

export function createModelRoutes(models: ModelService) {
  const routes = new Hono();

  routes.get('/', c => success(c, { items: models.list({
    limit: numberQuery(c, 'limit'),
    offset: numberQuery(c, 'offset'),
  }) }));
  routes.get('/:id', c => success(c, { item: models.require(c.req.param('id')) }));
  routes.post('/', async c => {
    const item = models.create(await readJson<CreateModelInput>(c));
    return success(c, { item }, 201);
  });
  routes.patch('/:id', async c => {
    const item = models.update(c.req.param('id'), await readJson<UpdateModelInput>(c));
    if (!item) throw new AppError('MODEL_CONFIG_NOT_FOUND');
    return success(c, { item });
  });
  routes.delete('/:id', c => {
    const id = c.req.param('id');
    if (!models.delete(id)) throw new AppError('MODEL_CONFIG_NOT_FOUND');
    return success(c, { id });
  });

  return routes;
}
