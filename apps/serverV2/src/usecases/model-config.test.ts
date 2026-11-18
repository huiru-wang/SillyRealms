import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../database/connection.js';
import { ModelService } from '../modules/models/service.js';
import { CredentialService } from '../modules/credentials/service.js';
import { memoryCredentials } from '../testing/credentials.js';
import { createModelConfigUsecases } from './model-config.js';

let db: DatabaseSync;
beforeEach(() => { db = openDatabase(':memory:'); });
afterEach(() => db.close());
const input = { name: 'Test model', providerId: 'test', modelId: 'model', apiKey: 'test-only-secret' };

function setup() {
  const store = memoryCredentials(), models = new ModelService(db);
  const credentials = new CredentialService('/test/v2-model-config', store);
  return { store, models, credentials, operations: createModelConfigUsecases({ models, credentials }) };
}

describe('model configuration and credential functions', () => {
  it('keeps secrets out of records, preserves omitted keys and supports replacement and deletion', async () => {
    const { operations, credentials } = setup();
    const created = await operations.create(input);
    expect(created).not.toHaveProperty('apiKey');
    expect(JSON.stringify(db.prepare('SELECT * FROM api_model_configs').all())).not.toContain(input.apiKey);
    expect(await credentials.status(created.credentialRef)).toBe('configured');
    await operations.update(created.id, { name: 'Renamed' });
    expect(await credentials.get(created.credentialRef)).toBe(input.apiKey);
    await operations.update(created.id, { apiKey: 'replacement' });
    expect(await credentials.get(created.credentialRef)).toBe('replacement');
    expect(await operations.delete(created.id)).toBe(true);
    expect(await credentials.status(created.credentialRef)).toBe('missing');
    expect(await operations.delete(created.id)).toBe(false);
  });

  it('leaves credentials intact when a referenced model cannot be deleted', async () => {
    const { operations, credentials } = setup();
    const model = await operations.create(input);
    db.prepare('INSERT INTO app_settings VALUES(1,NULL,?,1,1)').run(model.id);
    await expect(operations.delete(model.id)).rejects.toThrow();
    expect(await credentials.get(model.credentialRef)).toBe(input.apiKey);
  });

  it('restores the previous secret if updating the model record fails', async () => {
    const { operations, credentials } = setup();
    const model = await operations.create(input);
    db.exec('PRAGMA query_only=ON');
    await expect(operations.update(model.id, { apiKey: 'must-rollback' })).rejects.toThrow();
    expect(await credentials.get(model.credentialRef)).toBe(input.apiKey);
    db.exec('PRAGMA query_only=OFF');
  });

  it('can retry credential cleanup after the database deletion has committed', async () => {
    const { operations, credentials, store, models } = setup();
    const model = await operations.create(input), remove = store.delete;
    store.delete = async () => { throw new Error('store unavailable'); };
    await expect(operations.delete(model.id)).rejects.toThrow('CREDENTIAL_DELETE_FAILED');
    expect(models.get(model.id)).toBeNull();
    store.delete = remove;
    expect(await operations.delete(model.id)).toBe(true);
    expect(await credentials.status(model.credentialRef)).toBe('missing');
  });

  it('distinguishes inaccessible credentials and rejects invalid user input', async () => {
    const { operations, credentials, store } = setup();
    const model = await operations.create(input);
    store.has = async () => { throw new Error('denied'); };
    expect(await credentials.status(model.credentialRef)).toBe('unavailable');
    expect(await credentials.status('external:reference')).toBe('missing');
    await expect(operations.create({ ...input, apiKey: ' ' })).rejects.toThrow();
    await expect(operations.update(model.id, { providerId: 'different' })).rejects.toThrow('更换服务商');
  });
});
