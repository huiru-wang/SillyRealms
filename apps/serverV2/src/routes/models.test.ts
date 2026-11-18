import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createApp } from '../app.js';
import { openDatabase } from '../database/connection.js';
import { EventHub } from '../events/event-hub.js';
import { createServices, type Services } from '../services.js';

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

const base = '/api/v1/api-model-configs';
const model = {
  id: 'model', name: 'Local model', provider_id: 'provider', model_id: 'model-v1', credential_ref: 'vault:local',
};

describe('model configuration HTTP operations', () => {
  it('persists connection references, updates selected fields and deletes a configuration', async () => {
    const created = await app.request(base, write('POST', model));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      success: true, errorCode: null, errorMessage: '',
      data: { item: { ...model, created_at: expect.any(Number), updated_at: expect.any(Number) } },
    });
    const fetched = await app.request(base + '/model');
    expect((await fetched.json()).data.item).toMatchObject(model);
    const listed = await app.request(base + '?limit=1&offset=0');
    expect((await listed.json()).data.items.map((item: { id: string }) => item.id)).toEqual(['model']);
    const updated = await app.request(base + '/model', write('PATCH', { model_id: 'model-v2' }));
    expect(updated.status).toBe(200);
    expect((await updated.json()).data.item).toMatchObject({ ...model, model_id: 'model-v2' });

    const deleted = await app.request(base + '/model', { method: 'DELETE' });
    expect(await deleted.json()).toEqual({ success: true, errorCode: null, errorMessage: '', data: { id: 'model' } });
    await expectFailure(await app.request(base + '/model'), 404, 'MODEL_CONFIG_NOT_FOUND');
    await expectFailure(await app.request(base + '/model', write('PATCH', { name: 'Missing' })), 404, 'MODEL_CONFIG_NOT_FOUND');
    await expectFailure(await app.request(base + '/model', { method: 'DELETE' }), 404, 'MODEL_CONFIG_NOT_FOUND');
  });

  it('rejects credential bytes, invalid updates and pagination, and conflicting IDs', async () => {
    await expectFailure(await app.request(base, write('POST', { ...model, apiKey: 'not-a-real-key' })), 400);
    expect(services.models.list()).toEqual([]);
    expect((await app.request(base, write('POST', model))).status).toBe(201);
    await expectFailure(await app.request(base, write('POST', { ...model, name: 'Duplicate ID' })), 409, 'RESOURCE_CONFLICT');
    await expectFailure(await app.request(base + '/model', write('PATCH', { credential_ref: ' ' })), 400);
    await expectFailure(await app.request(base + '/model', write('PATCH', {})), 400);
    for (const query of ['?limit=abc', '?limit=1001', '?offset=-1', '?offset=0.5']) {
      await expectFailure(await app.request(base + query), 400);
    }
    expect(services.models.get('model')).toMatchObject(model);
  });
});
