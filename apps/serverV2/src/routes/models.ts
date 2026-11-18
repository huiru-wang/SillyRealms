import { Hono } from 'hono';
import { AppError } from '../errors.js';
import { offsetPage, readOffsetPagination } from '../http/pagination.js';
import { readJson, success } from '../http/response.js';
import type { CreateModelInput, ModelConfig, ModelService, UpdateModelInput } from '../models/service.js';

function modelResponse(model: ModelConfig) {
  return {
    id: model.id, name: model.name, providerId: model.providerId, modelId: model.modelId,
    createdAt: model.createdAt, updatedAt: model.updatedAt,
  };
}

export function createModelRoutes(models: ModelService) {
  const routes = new Hono();

  routes.get('/', c => {
    const pagination = readOffsetPagination(c, 'models', { defaultLimit: 100, maxLimit: 1000 });
    const { items, hasMore } = models.listPage(pagination);
    return success(c, offsetPage(items.map(modelResponse), hasMore, pagination, 'models'));
  });
  routes.get('/:id', c => success(c, { item: modelResponse(models.require(c.req.param('id'))) }));
  routes.post('/', async c => {
    const item = models.create(await readJson<CreateModelInput>(c));
    return success(c, { item: modelResponse(item) }, 201);
  });
  routes.patch('/:id', async c => {
    const item = models.update(c.req.param('id'), await readJson<UpdateModelInput>(c));
    if (!item) throw new AppError('MODEL_CONFIG_NOT_FOUND');
    return success(c, { item: modelResponse(item) });
  });
  routes.delete('/:id', c => {
    const id = c.req.param('id');
    if (!models.delete(id)) throw new AppError('MODEL_CONFIG_NOT_FOUND');
    return success(c, { id });
  });

  return routes;
}
