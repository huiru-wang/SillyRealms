import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createApp } from '../app.js';
import { openDatabase } from '../database/connection.js';
import { EventHub } from '../events/event-hub.js';
import { createServices, type Services } from '../services.js';
import { narrativePreset } from '../testing/fixtures.js';

let db: DatabaseSync, services: Services, app: ReturnType<typeof createApp>, dataRoot: string;
beforeEach(() => {
  db = openDatabase(':memory:');
  dataRoot = mkdtempSync(join(tmpdir(), 'sr-config-http-'));
  services = createServices(db, dataRoot);
  app = createApp({ events: new EventHub(), services });
});
afterEach(() => { app.shutdown(); db.close(); rmSync(dataRoot, { recursive: true, force: true }); });

function write(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function expectFailure(response: Response, status: number, errorCode?: string) {
  expect(response.status).toBe(status);
  const body = await response.json();
  expect(body).toEqual({
    success: false, errorCode: errorCode ?? expect.any(String), errorMessage: expect.any(String), data: null,
  });
  expect(body.errorMessage).not.toContain('UNIQUE constraint failed');
  expect(body.errorMessage).not.toContain('FOREIGN KEY constraint failed');
}

const base = '/api/v1/app-settings';

describe('application settings HTTP operations', () => {
  it('resolves references through services, preserves settings on failure, and permits explicit clearing', async () => {
    const initial = await app.request(base);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      success: true, errorCode: null, errorMessage: '',
      data: { item: { id: 1, default_preset_id: null, default_api_model_config_id: null } },
    });
    services.presets.create({ ...narrativePreset(), id: 'story' });
    services.models.create({
      id: 'model', name: 'Local', provider_id: 'provider', model_id: 'model', credential_ref: 'vault:model',
    });
    const saved = await app.request(base, write('PATCH', { default_preset_id: 'story', default_api_model_config_id: 'model' }));
    expect(saved.status).toBe(200);
    const previous = (await saved.json()).data.item;
    expect(previous).toMatchObject({ default_preset_id: 'story', default_api_model_config_id: 'model' });

    await expectFailure(await app.request(base, write('PATCH', {
      default_preset_id: null, default_api_model_config_id: 'missing',
    })), 404, 'MODEL_CONFIG_NOT_FOUND');
    await expectFailure(await app.request(base, write('PATCH', { default_preset_id: 'missing' })), 404, 'PRESET_NOT_FOUND');
    expect((await (await app.request(base)).json()).data.item).toEqual(previous);
    await expectFailure(await app.request('/api/v1/presets/story', { method: 'DELETE' }), 409, 'REFERENCE_CONFLICT');
    await expectFailure(await app.request('/api/v1/api-model-configs/model', { method: 'DELETE' }), 409);

    const cleared = await app.request(base, write('PATCH', { default_preset_id: null, default_api_model_config_id: null }));
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).data.item).toMatchObject({ default_preset_id: null, default_api_model_config_id: null });
    expect((await app.request('/api/v1/presets/story', { method: 'DELETE' })).status).toBe(200);
    expect((await app.request('/api/v1/api-model-configs/model', { method: 'DELETE' })).status).toBe(200);
  });

  it('rejects empty, malformed and invalid settings updates without changing the singleton', async () => {
    const previous = services.settings.get();
    for (const body of [{}, { default_preset_id: '' }, { default_api_model_config_id: 7 }, { unexpected: true }]) {
      await expectFailure(await app.request(base, write('PATCH', body)), 400);
    }
    await expectFailure(await app.request(base, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{',
    }), 400, 'INVALID_JSON');
    expect(services.settings.get()).toEqual(previous);
  });
});
