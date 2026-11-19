import { Hono } from 'hono';
import { success } from '../http/response.js';
import type { PiClient } from '../infrastructure/pi/client.js';

export function createProviderRoutes(pi: Pick<PiClient, 'listModels'>) {
  const routes = new Hono();
  routes.get('/models', c => success(c, { items: pi.listModels() }));
  return routes;
}
