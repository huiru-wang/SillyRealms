import { Hono } from 'hono';
import { AppError } from '../errors.js';
import { offsetPage, readOffsetPagination } from '../http/pagination.js';
import { readJson, success } from '../http/response.js';
import type { CredentialService } from '../modules/credentials/service.js';
import type { ModelConfig, ModelService } from '../modules/models/service.js';
import type { TestModel } from '../usecases/test-model.js';
import type { CreateModelConfig, ModelConfigUsecases, UpdateModelConfig } from '../usecases/model-config.js';

export function createModelRoutes(
  models: ModelService, credentials: CredentialService, usecases: ModelConfigUsecases,
  testModel: TestModel, shutdownSignal: AbortSignal,
) {
  const routes = new Hono();
  const view = async (model: ModelConfig) => ({
    id: model.id, name: model.name, providerId: model.providerId, modelId: model.modelId,
    createdAt: model.createdAt, updatedAt: model.updatedAt,
    credentialStatus: await credentials.status(model.credentialRef),
  });
  routes.get('/', async c => {
    const pagination = readOffsetPagination(c, 'models', { defaultLimit: 50, maxLimit: 1000 });
    const { items, hasMore } = models.listPage(pagination);
    // Bound OS credential-store calls instead of spawning one process for every row at once.
    const result: Awaited<ReturnType<typeof view>>[] = [];
    for (let offset = 0; offset < items.length; offset += 8) {
      result.push(...await Promise.all(items.slice(offset, offset + 8).map(view)));
    }
    return success(c, offsetPage(result, hasMore, pagination, 'models'));
  });
  routes.post('/:id/test', async c => success(c, await testModel(
    c.req.param('id'), AbortSignal.any([c.req.raw.signal, shutdownSignal]),
  )));
  routes.get('/:id', async c => success(c, { item: await view(models.require(c.req.param('id'))) }));
  routes.post('/', async c => success(c, {
    item: await view(await usecases.create(await readJson<CreateModelConfig>(c))),
  }, 201));
  routes.patch('/:id', async c => success(c, {
    item: await view(await usecases.update(c.req.param('id'), await readJson<UpdateModelConfig>(c))),
  }));
  routes.delete('/:id', async c => {
    const id = c.req.param('id');
    if (!await usecases.delete(id)) throw new AppError('MODEL_CONFIG_NOT_FOUND');
    return success(c, { id });
  });
  return routes;
}
