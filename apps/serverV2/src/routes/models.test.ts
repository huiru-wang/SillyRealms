import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { memoryCredentials } from '../testing/credentials.js';
import { createApp } from '../app.js';
import { openDatabase } from '../infrastructure/database/connection.js';
import { bindTransaction } from '../infrastructure/database/transaction.js';
import { createUsecases } from '../usecases.js';
import { EventHub } from '../infrastructure/events/event-hub.js';
import { createServices, type Services } from '../services.js';

let db: DatabaseSync, services: Services, app: ReturnType<typeof createApp>, dataRoot: string;
beforeEach(() => {
  db = openDatabase(':memory:');
  dataRoot = mkdtempSync(join(tmpdir(), 'sr-config-http-'));
  services = createServices(db, dataRoot, memoryCredentials());
  services.settings.ensure({ defaultPresetId: null, defaultApiModelConfigId: null });
  const events = new EventHub();
  app = createApp({ events, services, usecases: createUsecases({ services, transaction: bindTransaction(db), events }) });
});
afterEach(async () => { await app.shutdown(); db.close(); rmSync(dataRoot, { recursive: true, force: true }); });

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
  id: 'model', name: 'Local model', providerId: 'provider', modelId: 'model-v1', credentialRef: 'vault:local',
};

describe('model configuration HTTP operations', () => {
  it('stores credentials privately and returns configuration status', async () => {
    const input = { name: model.name, providerId: model.providerId, modelId: model.modelId, apiKey: 'test-key' };
    const created = await app.request(base, write('POST', input));
    expect(created.status).toBe(201);
    const item = (await created.json()).data.item;
    const expected = { name: input.name, providerId: input.providerId, modelId: input.modelId, credentialStatus: 'configured' };
    expect(item).toMatchObject(expected);
    expect(item).not.toHaveProperty('credentialRef');
    expect(item).not.toHaveProperty('apiKey');
    const id = item.id;
    const fetched = await app.request(base + '/' + id);
    expect((await fetched.json()).data.item).toEqual(item);
    const listed = await app.request(base + '?limit=1&offset=0');
    expect((await listed.json()).data).toMatchObject({ items: [expected], hasMore: false, nextCursor: null });
    const updated = await app.request(base + '/' + id, write('PATCH', { modelId: 'model-v2' }));
    expect(updated.status).toBe(200);
    expect((await updated.json()).data.item).toMatchObject({ ...expected, modelId: 'model-v2' });
    const deleted = await app.request(base + '/' + id, { method: 'DELETE' });
    expect(await deleted.json()).toEqual({ success: true, errorCode: null, errorMessage: '', data: { id } });
    await expectFailure(await app.request(base + '/' + id), 404, 'MODEL_CONFIG_NOT_FOUND');
    await expectFailure(await app.request(base + '/' + id, write('PATCH', { name: 'Missing' })), 404, 'MODEL_CONFIG_NOT_FOUND');
    await expectFailure(await app.request(base + '/' + id, { method: 'DELETE' }), 404, 'MODEL_CONFIG_NOT_FOUND');
  });

  it('rejects client credential references, invalid updates and pagination', async () => {
    await expectFailure(await app.request(base, write('POST', { ...model, apiKey: 'test-key' })), 400);
    expect(services.models.list()).toEqual([]);
    services.models.create(model);
    await expectFailure(await app.request(base + '/model', write('PATCH', { credentialRef: ' ' })), 400);
    await expectFailure(await app.request(base + '/model', write('PATCH', { apiKey: ' ' })), 400);
    await expectFailure(await app.request(base + '/model', write('PATCH', {})), 400);
    for (const query of ['?limit=abc', '?limit=1001', '?offset=-1', '?offset=0.5']) {
      await expectFailure(await app.request(base + query), 400);
    }
    expect(services.models.get('model')).toMatchObject(model);
  });

  it('paginates model configuration responses using an opaque cursor', async () => {
    for (const id of ['one', 'two', 'three']) services.models.create({ ...model, id, name: id });
    const first = (await (await app.request(base + '?limit=2')).json()).data;
    expect(first).toMatchObject({ hasMore: true, nextCursor: expect.any(String) });
    const second = (await (await app.request(base + '?limit=2&cursor=' + encodeURIComponent(first.nextCursor))).json()).data;
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });
    expect(new Set([...first.items, ...second.items].map((item: { id: string }) => item.id))).toEqual(new Set(['one', 'two', 'three']));
    expect([...first.items, ...second.items].every(item => !Object.hasOwn(item, 'credentialRef'))).toBe(true);
    await expectFailure(await app.request(base + '?cursor=invalid'), 400, 'INVALID_REQUEST');
  });
});
