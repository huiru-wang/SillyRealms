import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createApp } from '../app.js';
import { openDatabase } from '../infrastructure/database/connection.js';
import { bindTransaction } from '../infrastructure/database/transaction.js';
import { createUsecases } from '../usecases.js';
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

const base = '/api/v1/app-settings';

describe('application settings HTTP operations', () => {
  it('resolves references through services, preserves settings on failure, and permits explicit clearing', async () => {
    const initial = await app.request(base);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      success: true, errorCode: null, errorMessage: '',
      data: { item: { id: 1, locale: 'zh-CN', coverMosaicDensity: 24, defaultPresetId: null, defaultApiModelConfigId: null } },
    });
    services.presets.create({ ...narrativePreset(), id: 'story' });
    services.models.create({
      id: 'model', name: 'Local', providerId: 'provider', modelId: 'model', credentialRef: 'vault:model',
    });
    const saved = await app.request(base, write('PATCH', { defaultPresetId: 'story', defaultApiModelConfigId: 'model' }));
    expect(saved.status).toBe(200);
    const previous = (await saved.json()).data.item;
    expect(previous).toMatchObject({ defaultPresetId: 'story', defaultApiModelConfigId: 'model' });

    await expectFailure(await app.request(base, write('PATCH', {
      defaultPresetId: null, defaultApiModelConfigId: 'missing',
    })), 404, 'MODEL_CONFIG_NOT_FOUND');
    await expectFailure(await app.request(base, write('PATCH', { defaultPresetId: 'missing' })), 404, 'PRESET_NOT_FOUND');
    expect((await (await app.request(base)).json()).data.item).toEqual(previous);
    await expectFailure(await app.request('/api/v1/presets/story', { method: 'DELETE' }), 409, 'REFERENCE_CONFLICT');
    await expectFailure(await app.request('/api/v1/api-model-configs/model', { method: 'DELETE' }), 409);

    const cleared = await app.request(base, write('PATCH', { defaultPresetId: null, defaultApiModelConfigId: null }));
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).data.item).toMatchObject({ defaultPresetId: null, defaultApiModelConfigId: null });
    expect((await app.request('/api/v1/presets/story', { method: 'DELETE' })).status).toBe(200);
    expect((await app.request('/api/v1/api-model-configs/model', { method: 'DELETE' })).status).toBe(200);
  });

  it('round-trips all three supported languages without changing the application defaults', async () => {
    for (const locale of ['en', 'ja', 'zh-CN']) {
      const saved = await app.request(base, write('PATCH', { locale }));
      expect(saved.status).toBe(200);
      expect((await saved.json()).data.item)
        .toMatchObject({ locale, defaultPresetId: null, defaultApiModelConfigId: null });
      expect((await (await app.request(base)).json()).data.item.locale).toBe(locale);
    }
  });

  it('round-trips cover density while retaining unrelated settings', async () => {
    await app.request(base, write('PATCH', { locale: 'ja' }));
    for (const coverMosaicDensity of [8, 24, 64]) {
      const saved = await app.request(base, write('PATCH', { coverMosaicDensity }));
      expect(saved.status).toBe(200);
      expect((await saved.json()).data.item).toMatchObject({
        coverMosaicDensity, locale: 'ja', defaultPresetId: null, defaultApiModelConfigId: null,
      });
      expect((await (await app.request(base)).json()).data.item.coverMosaicDensity).toBe(coverMosaicDensity);
    }
  });

  it('rejects empty, malformed and invalid settings updates without changing the singleton', async () => {
    const previous = services.settings.get();
    for (const body of [{}, { defaultPresetId: '' }, { defaultApiModelConfigId: 7 }, { unexpected: true },
      { locale: null }, { locale: 'fr' }, { locale: 'EN' }, { locale: 'ja-JP' }, { locale: '' }, { locale: 1 },
      { coverMosaicDensity: null }, { coverMosaicDensity: '24' }, { coverMosaicDensity: 7 }, { coverMosaicDensity: 65 }, { coverMosaicDensity: 24.5 }]) {
      await expectFailure(await app.request(base, write('PATCH', body)), 400);
    }
    await expectFailure(await app.request(base, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{',
    }), 400, 'INVALID_JSON');
    expect(services.settings.get()).toEqual(previous);
  });
});
