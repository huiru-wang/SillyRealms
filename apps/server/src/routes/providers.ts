import { Hono } from 'hono';
import { success } from '../http/response.js';
import type { ModelClient } from '../infrastructure/model/client.js';

export function createProviderRoutes(modelClient: Pick<ModelClient, 'listProviders'>) {
  const routes = new Hono();
  routes.get('/models', c => success(c, { items: modelClient.listProviders() }));
  return routes;
}
