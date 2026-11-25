import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { createApp } from '../app.js';
import { bindTransaction } from '../infrastructure/database/transaction.js';
import { errorHandler } from '../http/response.js';
import { createPresetRoutes } from './presets.js';
import { createUsecases } from '../usecases.js';
import { openDatabase } from '../infrastructure/database/connection.js';
import { EventHub } from '../infrastructure/events/event-hub.js';
import { createServices, type Services } from '../services.js';
import { narrativePreset } from '../testing/fixtures.js';

let db: DatabaseSync, services: Services, app: ReturnType<typeof createApp>, dataRoot: string;
beforeEach(() => {
  db = openDatabase(':memory:');
  dataRoot = mkdtempSync(join(tmpdir(), 'sr-config-http-'));
  services = createServices(db, dataRoot);
  services.settings.ensure({ defaultPresetId: null, defaultApiModelConfigId: null });
  const events = new EventHub();
  const usecases = createUsecases({ services, transaction: bindTransaction(db), events });
  app = createApp({ events, services, usecases });
});
afterEach(async () => { await app.shutdown(); db.close(); rmSync(dataRoot, { recursive: true, force: true }); });

function write(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(method === 'PATCH' ? { expectedRevision: 1, ...body as object } : body) };
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

function portablePreset(name = 'Story') {
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

const webPreset = narrativePreset;

describe('preset HTTP operations', () => {
  it('reports the actual settings, world and session references that block deletion', async () => {
    const preset = services.presets.create(webPreset());
    services.settings.update({ defaultPresetId: preset.id });
    services.models.create({ id: 'model', name: 'Model', providerId: 'provider', modelId: 'm', credentialRef: 'ref' });
    const world = services.worlds.create({
      id: 'world', name: '小饭馆', specVersion: '0.1', defaultPresetId: preset.id,
      characters: [{ id: 'player', name: '掌柜', player_selectable: true }],
      openings: [{ id: 'opening', name: '开局', content: '开门' }],
    });
    const session = { worldId: world.id, userCharacterId: 'player', runtimeConfig: { narrativePresetId: preset.id, apiModelConfigId: 'model' } };
    services.sessions.create({ ...session, id: 'unnamed' });
    services.sessions.create({ ...session, id: 'morning', title: '早市' });
    services.sessions.create({ ...session, id: 'market', title: '早市' });
    const remove = () => app.request(base + '/' + preset.id, { method: 'DELETE' });
    const blocked = await remove();
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      success: false, errorCode: 'REFERENCE_CONFLICT', data: null,
      errorMessage: expect.stringContaining('应用设置中的默认预设；世界卡“小饭馆”的默认预设；会话“未命名会话”（unnamed）、“早市”（market）、“早市”（morning）的叙事预设'),
    });
    services.settings.update({ defaultPresetId: null });
    services.worlds.update(world.id, { defaultPresetId: null });
    services.sessions.delete('unnamed');
    services.sessions.delete('market');
    const { errorMessage } = await (await remove()).json();
    expect(errorMessage).toContain('会话“早市”的叙事预设');
    expect(errorMessage).not.toMatch(/默认预设|小饭馆|unnamed/);
    services.sessions.delete('morning');
    expect((await remove()).status).toBe(200);
    await expectFailure(await remove(), 404, 'PRESET_NOT_FOUND');
  });

  it('accepts Web create/edit payloads and projects the detail shape it consumes', async () => {
    const input = { ...webPreset(), id: 'story' };
    input.config.nodes[0]!.prompt = 'author_key stays unchanged {{world.lore}}';
    const created = await app.request(base, write('POST', input));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      success: true, errorCode: null, errorMessage: '',
      data: { item: { ...input, revision: 1, createdAt: expect.any(Number), updatedAt: expect.any(Number) } },
    });
    expect(services.presets.require('story').config).toMatchObject({
      schemaVersion: 1, nodes: input.config.nodes,
      contextStrategy: { maxContextTokens: input.config.contextStrategy.maxContextTokens },
      modelParameters: { thinkingEnabled: input.config.modelParameters.thinkingEnabled },
    });

    const listed = await app.request(base + '?type=narrative&limit=1&offset=0');
    expect(listed.status).toBe(200);
    const page = (await listed.json()).data;
    expect(page).toEqual({
      items: [{
        id: 'story', revision: 1, type: 'narrative', name: 'Story', description: input.description,
        createdAt: expect.any(Number), updatedAt: expect.any(Number),
      }],
      hasMore: false, nextCursor: null,
    });
    const fetched = await app.request(base + '/story');
    expect((await fetched.json()).data.item.config).toEqual(input.config);

    const changed = { ...webPreset('Renamed'), config: structuredClone(input.config) };
    changed.config.modelParameters.thinkingEnabled = true;
    const updated = await app.request(base + '/story', write('PATCH', changed));
    expect(updated.status).toBe(200);
    expect((await updated.json()).data.item).toMatchObject(changed);
    const renamed = await app.request(base + '/story', write('PATCH', { name: 'Only name', expectedRevision: 2 }));
    expect((await renamed.json()).data.item).toMatchObject({
      name: 'Only name', revision: 3, config: { ...input.config, modelParameters: { ...input.config.modelParameters, thinkingEnabled: true } },
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
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(webPreset()),
    }), 415);
    await expectFailure(await app.request(base, write('POST', [])), 400, 'INVALID_REQUEST');
    await expectFailure(await app.request(base, write('POST', { ...webPreset(), extra: true })), 400);
    await expectFailure(await app.request(base, write('POST', {
      ...webPreset(), config: { ...webPreset().config, extra: true },
    })), 400);
    await expectFailure(await app.request(base, write('POST', {
      ...webPreset(), config: { ...webPreset().config, schemaVersion: 3 },
    })), 400);

    const invalid = webPreset();
    invalid.config.nodes.reverse();
    await expectFailure(await app.request(base, write('POST', invalid)), 400);
    expect(services.presets.list()).toEqual([]);
    services.presets.create({ ...narrativePreset(), id: 'story' });
    await expectFailure(await app.request(base + '/story', write('PATCH', { name: 'Changed', extra: true })), 400);
    expect(services.presets.require('story').name).toBe('Story');
  });

  it('reports duplicate preset names as conflicts without changing the original record', async () => {
    const first = await app.request(base, write('POST', { ...webPreset('Unique'), id: 'first' }));
    expect(first.status).toBe(201);
    await expectFailure(await app.request(base, write('POST', { ...webPreset('Unique'), id: 'second' })), 409, 'RESOURCE_CONFLICT');
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

  it('serves the built-in template without creating or overwriting a saved preset', async () => {
    const response = await app.request(base + '/default');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      success: true, errorCode: null, errorMessage: '',
      data: { item: { name: '标准叙事', config: { schemaVersion: 1 } } },
    });
    expect(body.data.item.config.nodes.map((node: { id: string }) => node.id)).toEqual([
      'main', 'personaInfo', 'characterInfo', 'worldInfo', 'worldState', 'chatHistory', 'userInput', 'stateUpdate', 'actionSuggestions', 'characterSprite',
    ]);
    expect(body.data.item).not.toHaveProperty('id');
    expect(services.presets.list()).toEqual([]);
    const created = await app.request(base, write('POST', { ...body.data.item, name: '未命名预设' }));
    expect(created.status).toBe(201);
    const id = (await created.json()).data.item.id;
    services.presets.update(id, { name: 'Edited' });
    await app.request(base + '/default');
    expect(services.presets.require(id).name).toBe('Edited');
    expect(services.presets.list()).toHaveLength(1);
  });

  it('imports Web documents with unique names and exports the current saved document as a download', async () => {
    const document = portablePreset('导入预设');
    const first = await app.request(base + '/import', write('POST', document));
    expect(first.status).toBe(201);
    const item = (await first.json()).data.item;
    expect(item).toMatchObject({ ...narrativePreset('导入预设'), revision: 1 });
    const duplicate = await app.request(base + '/import', write('POST', document));
    expect(duplicate.status).toBe(201);
    expect((await duplicate.json()).data.item.name).toBe('导入预设(1)');
    const updated = await app.request(base + '/' + item.id, write('PATCH', { name: '当前预设' }));
    expect(updated.status).toBe(200);

    const exported = await app.request(base + '/' + item.id + '/export');
    expect(exported.status).toBe(200);
    expect(exported.headers.get('Content-Type')).toContain('application/json');
    expect(exported.headers.get('Content-Disposition')).toContain("filename*=UTF-8''" + encodeURIComponent('当前预设.json'));
    const text = await exported.text();
    expect(Number(exported.headers.get('Content-Length'))).toBe(new TextEncoder().encode(text).byteLength);
    const value = JSON.parse(text);
    expect(value).toEqual({ ...document, type: 'narrative', name: '当前预设' });
    expect(value).not.toHaveProperty('success');
    expect(value).not.toHaveProperty('id');
    expect(value).not.toHaveProperty('createdAt');

    const head = await app.request(base + '/' + item.id + '/export', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(head.headers.get('Content-Length')).toBe(exported.headers.get('Content-Length'));
    expect((await app.request(base + '/import', write('POST', value))).status).toBe(201);
  });

  it('keeps import and export errors enveloped and reports unavailable usecases', async () => {
    await expectFailure(await app.request(base + '/import', write('POST', {
      ...webPreset(), unknown: true,
    })), 400, 'INVALID_REQUEST');
    await expectFailure(await app.request(base + '/import', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    }), 400, 'INVALID_JSON');
    expect(services.presets.list()).toEqual([]);
    await expectFailure(await app.request(base + '/missing/export'), 404, 'PRESET_NOT_FOUND');

    const unavailable = new Hono().onError(errorHandler).route(base, createPresetRoutes(services.presets));
    await expectFailure(await unavailable.request(base + '/import', write('POST', webPreset())), 503, 'SERVICE_UNAVAILABLE');
    await expectFailure(await unavailable.request(base + '/missing/export'), 503, 'SERVICE_UNAVAILABLE');
  });
});
