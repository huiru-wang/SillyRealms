import { expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { openDatabase } from '../src/infrastructure/database/database.js';
import { providerRoutes } from '../src/routes/providers.js';
import { fakeCredentials, seedModel } from './fixtures/db-seed.js';
import { textGateway } from './fixtures/runtime-v2.js';

it.each(['success', 'credential-failure', 'database-failure'] as const)('deletes config synchronously: %s', async mode => {
  const db = openDatabase(':memory:');
  try {
    seedModel(db);
    let keyPresent = true;
    const deleteSync = vi.fn(() => {
      expect(db.isTransaction).toBe(true);
      expect(db.prepare('SELECT id FROM api_model_configs').get()).toBeUndefined();
      if (mode === 'credential-failure') throw new Error('test failure');
      keyPresent = false;
    });
    if (mode === 'database-failure') db.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON api_model_configs BEGIN SELECT RAISE(ABORT,'test failure'); END;");
    const app = new Hono().route('/models', providerRoutes(db, { ...fakeCredentials, deleteSync }, textGateway('')).configs);
    const response = await app.request('/models/test-model', { method: 'DELETE' });
    expect(response.status).toBe(mode === 'success' ? 200 : 500);
    expect(!!db.prepare('SELECT id FROM api_model_configs').get()).toBe(mode !== 'success');
    expect(keyPresent).toBe(mode !== 'success');
    expect(deleteSync).toHaveBeenCalledTimes(mode === 'database-failure' ? 0 : 1);
    expect(db.isTransaction).toBe(false);
  } finally { db.close(); }
});
