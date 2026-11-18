import { Hono } from 'hono';
import { readJson, success } from '../http/response.js';
import type { SettingsPatch, SettingsService } from '../settings/service.js';

export function createSettingsRoutes(settings: SettingsService) {
  const routes = new Hono();

  routes.get('/', c => success(c, { item: settings.get() }));
  routes.patch('/', async c => {
    const item = settings.update(await readJson<SettingsPatch>(c));
    return success(c, { item });
  });

  return routes;
}
