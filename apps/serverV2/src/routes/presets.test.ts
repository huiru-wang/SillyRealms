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

const base = '/api/v1/presets';

describe('preset HTTP operations', () => {
  it('creates, lists, reads, updates and deletes a validated preset through the common envelope', async () => {
    const input = { ...narrativePreset(), id: 'story' };
    const created = await app.request(base, write('POST', input));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      success: true, errorCode: null, errorMessage: '',
      data: { item: { ...input, created_at: expect.any(Number), updated_at: expect.any(Number) } },
    });

    const listed = await app.request(base + '?type=narrative&limit=1&offset=0');
    expect(listed.status).toBe(200);
    expect((await listed.json()).data.items.map((item: { id: string }) => item.id)).toEqual(['story']);
    const fetched = await app.request(base + '/story');
    expect((await fetched.json()).data.item.config_json).toEqual(input.config_json);

    const updated = await app.request(base + '/story', write('PATCH', { name: 'Renamed' }));
    expect(updated.status).toBe(200);
    expect((await updated.json()).data.item).toMatchObject({
      name: 'Renamed', description: input.description, config_json: input.config_json,
    });

    const deleted = await app.request(base + '/story', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ success: true, errorCode: null, errorMessage: '', data: { id: 'story' } });
    await expectFailure(await app.request(base + '/story'), 404, 'PRESET_NOT_FOUND');
    await expectFailure(await app.request(base + '/story', write('PATCH', { name: 'Missing' })), 404, 'PRESET_NOT_FOUND');
    await expectFailure(await app.request(base + '/story', { method: 'DELETE' }), 404, 'PRESET_NOT_FOUND');
  });

  it('rejects invalid query values, malformed or non-object JSON, and invalid narrative configuration', async () => {
    for (const query of ['?type=image', '?limit=zero', '?limit=0', '?offset=-1', '?offset=1.5']) {
      await expectFailure(await app.request(base + query), 400);
    }
    await expectFailure(await app.request(base, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    }), 400, 'INVALID_JSON');
    await expectFailure(await app.request(base, {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(narrativePreset()),
    }), 415);
    await expectFailure(await app.request(base, write('POST', [])), 400, 'INVALID_REQUEST');

    const invalid = narrativePreset();
    invalid.config_json.nodes.reverse();
    await expectFailure(await app.request(base, write('POST', invalid)), 400);
    expect(services.presets.list()).toEqual([]);
  });

  it('reports duplicate preset names as conflicts without changing the original record', async () => {
    const first = await app.request(base, write('POST', { ...narrativePreset('Unique'), id: 'first' }));
    expect(first.status).toBe(201);
    await expectFailure(await app.request(base, write('POST', { ...narrativePreset('Unique'), id: 'second' })), 409, 'RESOURCE_CONFLICT');
    expect(services.presets.list().map(item => item.id)).toEqual(['first']);
  });
});
