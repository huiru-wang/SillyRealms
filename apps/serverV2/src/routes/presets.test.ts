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

function studioPreset(name = 'Story') {
  const value = narrativePreset(name);
  return {
    name: value.name,
    description: value.description,
    config_json: { schemaVersion: 3, nodes: structuredClone(value.config.nodes) },
    context_strategy: {
      strategy: value.config.contextStrategy.strategy,
      max_context_tokens: value.config.contextStrategy.maxContextTokens,
      max_output_tokens: value.config.contextStrategy.maxOutputTokens,
      summary_prompt: value.config.contextStrategy.summaryPrompt,
    },
    model_parameters: {
      temperature: value.config.modelParameters.temperature,
      thinking_enabled: value.config.modelParameters.thinkingEnabled,
    },
  };
}

describe('preset HTTP operations', () => {
  it('accepts Studio create/edit payloads and projects the detail shape it consumes', async () => {
    const input = { ...studioPreset(), id: 'story' };
    input.config_json.nodes[0]!.prompt = 'author_key stays unchanged {{world.lore}}';
    const created = await app.request(base, write('POST', input));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      success: true, errorCode: null, errorMessage: '',
      data: { item: { ...input, type: 'narrative', createdAt: expect.any(Number), updatedAt: expect.any(Number) } },
    });
    expect(services.presets.require('story').config).toMatchObject({
      schemaVersion: 1, nodes: input.config_json.nodes,
      contextStrategy: { maxContextTokens: input.context_strategy.max_context_tokens },
      modelParameters: { thinkingEnabled: input.model_parameters.thinking_enabled },
    });

    const listed = await app.request(base + '?type=narrative&limit=1&offset=0');
    expect(listed.status).toBe(200);
    const page = (await listed.json()).data;
    expect(page).toEqual({
      items: [{
        id: 'story', type: 'narrative', name: 'Story', description: input.description,
        createdAt: expect.any(Number), updatedAt: expect.any(Number),
      }],
      hasMore: false, nextCursor: null,
    });
    const fetched = await app.request(base + '/story');
    expect((await fetched.json()).data.item.config_json).toEqual(input.config_json);

    const changed = { ...studioPreset('Renamed'), config_json: input.config_json };
    changed.model_parameters.thinking_enabled = true;
    const updated = await app.request(base + '/story', write('PATCH', changed));
    expect(updated.status).toBe(200);
    expect((await updated.json()).data.item).toMatchObject(changed);
    const renamed = await app.request(base + '/story', write('PATCH', { name: 'Only name' }));
    expect((await renamed.json()).data.item).toMatchObject({
      name: 'Only name', config_json: input.config_json, model_parameters: { thinking_enabled: true },
    });

    const deleted = await app.request(base + '/story', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ success: true, errorCode: null, errorMessage: '', data: { id: 'story' } });
    await expectFailure(await app.request(base + '/story'), 404, 'PRESET_NOT_FOUND');
    await expectFailure(await app.request(base + '/story', write('PATCH', { name: 'Missing' })), 404, 'PRESET_NOT_FOUND');
    await expectFailure(await app.request(base + '/story', { method: 'DELETE' }), 404, 'PRESET_NOT_FOUND');
  });

  it('rejects invalid protocol fields and business values without silently dropping unknown keys', async () => {
    for (const query of ['?type=image', '?limit=zero', '?limit=0', '?offset=-1', '?offset=1.5']) {
      await expectFailure(await app.request(base + query), 400);
    }
    await expectFailure(await app.request(base, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    }), 400, 'INVALID_JSON');
    await expectFailure(await app.request(base, {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(studioPreset()),
    }), 415);
    await expectFailure(await app.request(base, write('POST', [])), 400, 'INVALID_REQUEST');
    await expectFailure(await app.request(base, write('POST', { ...studioPreset(), extra: true })), 400);
    await expectFailure(await app.request(base, write('POST', {
      ...studioPreset(), context_strategy: { ...studioPreset().context_strategy, extra: true },
    })), 400);
    await expectFailure(await app.request(base, write('POST', {
      ...studioPreset(), config_json: { ...studioPreset().config_json, schemaVersion: 1 },
    })), 400);

    const invalid = studioPreset();
    invalid.config_json.nodes.reverse();
    await expectFailure(await app.request(base, write('POST', invalid)), 400);
    expect(services.presets.list()).toEqual([]);
    services.presets.create({ ...narrativePreset(), id: 'story' });
    await expectFailure(await app.request(base + '/story', write('PATCH', { name: 'Changed', extra: true })), 400);
    expect(services.presets.require('story').name).toBe('Story');
  });

  it('reports duplicate preset names as conflicts without changing the original record', async () => {
    const first = await app.request(base, write('POST', { ...studioPreset('Unique'), id: 'first' }));
    expect(first.status).toBe(201);
    await expectFailure(await app.request(base, write('POST', { ...studioPreset('Unique'), id: 'second' })), 409, 'RESOURCE_CONFLICT');
    expect(services.presets.list().map(item => item.id)).toEqual(['first']);
  });

  it('returns the next cursor and rejects malformed or differently scoped cursors', async () => {
    for (const id of ['one', 'two', 'three']) services.presets.create({ ...narrativePreset(id), id });
    const first = (await (await app.request(base + '?limit=2')).json()).data;
    expect(first).toMatchObject({ hasMore: true, nextCursor: expect.any(String) });
    expect(first.items).toHaveLength(2);
    const second = (await (await app.request(base + '?limit=2&cursor=' + encodeURIComponent(first.nextCursor))).json()).data;
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });
    expect(second.items).toHaveLength(1);
    expect(new Set([...first.items, ...second.items].map((item: { id: string }) => item.id))).toEqual(new Set(['one', 'two', 'three']));
    await expectFailure(await app.request(base + '?cursor=invalid'), 400, 'INVALID_REQUEST');
    await expectFailure(await app.request(base + '?type=image&cursor=' + encodeURIComponent(first.nextCursor)), 400, 'INVALID_REQUEST');
    await expectFailure(await app.request('/api/v1/api-model-configs?cursor=' + encodeURIComponent(first.nextCursor)), 400, 'INVALID_REQUEST');
    await expectFailure(await app.request(base + '?offset=0&cursor=' + encodeURIComponent(first.nextCursor)), 400, 'INVALID_REQUEST');
  });
});
