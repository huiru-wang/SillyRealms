import { ErrorCodes } from '../common/error-codes.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { z } from 'zod';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { ModelGateway } from '../agent/index.js';
import type { CredentialStore } from '../infrastructure/credentials/store.js';
import { referenceCounts } from '../repositories/config-references.js';
import { transaction } from '../domain/tags.js';

const input = z.object({ name: z.string().min(1), providerId: z.string().min(1), modelId: z.string().min(1), apiKey: z.string().min(1) }).strict();
const patch = input.partial().strict();
const catalog = builtinModels();
export function providerRoutes(db: DatabaseSync, credentials: CredentialStore, gateway: ModelGateway): { providers: Hono; configs: Hono } {
  const providers = new Hono(), configs = new Hono();
  const publicRow = async (row: Record<string, unknown>) => ({ id: row.id, name: row.name, providerId: row.provider_id, modelId: row.model_id, credentialConfigured: (await credentials.get(String(row.credential_ref))) !== null });
  const get = (id: string) => db.prepare('SELECT * FROM api_model_configs WHERE id=?').get(id);
  const validModel = (provider: string, model: string) => !!catalog.getModel(provider, model);
  providers.get('/models', c => c.json({ providers: catalog.getProviders().map(provider => ({ providerId: provider.id, models: catalog.getModels(provider.id).map(m => ({ id: m.id, name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens, toolSupport: 'unknown' })) })) }));
  configs.get('/', async c => { try { return c.json({ items: await Promise.all(db.prepare('SELECT * FROM api_model_configs ORDER BY name,id').all().map(publicRow)) }); } catch { return c.json({ error: { code: ErrorCodes.CREDENTIAL_STORE_ERROR, message: 'Credential store unavailable' } }, 500); } });
  configs.get('/:id', async c => { const row = get(c.req.param('id')); if (!row) return c.json({ error: { code: ErrorCodes.API_MODEL_CONFIG_NOT_FOUND, message: 'Model configuration not found' } }, 404); try { return c.json({ item: await publicRow(row) }); } catch { return c.json({ error: { code: ErrorCodes.CREDENTIAL_STORE_ERROR, message: 'Credential store unavailable' } }, 500); } });
  configs.post('/', async c => {
    try {
      const body = input.parse(await c.req.json());
      if (!validModel(body.providerId, body.modelId)) return c.json({ error: { code: ErrorCodes.MODEL_NOT_FOUND, message: 'Model not found' } }, 422);
      const id = randomUUID(), now = Date.now();
      await credentials.set(id, body.apiKey);
      try {
        transaction(db,()=>{
          db.prepare('INSERT INTO api_model_configs(id,name,provider_id,model_id,credential_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
            .run(id,body.name,body.providerId,body.modelId,id,now,now);
          db.prepare('UPDATE app_settings SET default_api_model_config_id=?,updated_at=? WHERE id=1 AND default_api_model_config_id IS NULL')
            .run(id,now);
        });
      } catch { await credentials.delete(id); throw new Error(ErrorCodes.CONFIG_SAVE_FAILED); }
      return c.json({ item: await publicRow(get(id)!) }, 201);
    } catch { return c.json({ error: { code: ErrorCodes.CONFIG_SAVE_FAILED, message: 'Could not save model configuration' } }, 422); }
  });
  configs.post('/:id/test', async c => {
    const row = get(c.req.param('id'));
    if (!row) return c.json({error:{code:ErrorCodes.API_MODEL_CONFIG_NOT_FOUND,message:'Model configuration not found'}},404);
    try {
      const key = await credentials.get(String(row.credential_ref));
      if (!key) return c.json({error:{code:ErrorCodes.CREDENTIAL_NOT_CONFIGURED,message:'Credential not configured'}},422);
      if (!gateway.verify) return c.json({error:{code:ErrorCodes.PROVIDER_TEST_UNAVAILABLE,message:'Connection test unavailable'}},422);
      const toolVerified = await gateway.verify(String(row.provider_id),String(row.model_id),key);
      return c.json({ok:true,toolVerified});
    } catch { return c.json({error:{code:ErrorCodes.PROVIDER_TEST_FAILED,message:'Connection test failed'}},502); }
  });
  configs.patch('/:id', async c => {
    const row = get(c.req.param('id'));
    if (!row) return c.json({ error: { code: ErrorCodes.API_MODEL_CONFIG_NOT_FOUND, message: 'Model configuration not found' } }, 404);
    try {
      const body = patch.parse(await c.req.json());
      const provider = body.providerId ?? String(row.provider_id), model = body.modelId ?? String(row.model_id);
      if (!validModel(provider, model)) return c.json({ error: { code: ErrorCodes.MODEL_NOT_FOUND, message: 'Model not found' } }, 422);
      const ref=String(row.credential_ref);
      const previous = body.apiKey === undefined ? null : await credentials.get(ref);
      if (body.apiKey !== undefined) await credentials.set(ref, body.apiKey);
      try { db.prepare('UPDATE api_model_configs SET name=?, provider_id=?, model_id=?, updated_at=? WHERE id=?').run(body.name ?? String(row.name), provider, model, Date.now(), String(row.id)); }
      catch (err) {
        if (body.apiKey !== undefined) { if (previous === null) await credentials.delete(ref); else await credentials.set(ref,previous); }
        throw err;
      }
      return c.json({ item: await publicRow(get(String(row.id))!) });
    } catch { return c.json({ error: { code: ErrorCodes.CONFIG_UPDATE_FAILED, message: 'Could not update model configuration' } }, 422); }
  });
  configs.delete('/:id', async c => {
    const row = get(c.req.param('id'));
    if (!row) return c.json({ error: { code: ErrorCodes.API_MODEL_CONFIG_NOT_FOUND, message: 'Model configuration not found' } }, 404);
    const refs=referenceCounts(db,'model',String(row.id));
    if(refs.total>0) return c.json({error:{code:ErrorCodes.CONFIG_IN_USE,counts:refs}},409);
    try { await credentials.delete(String(row.credential_ref)); db.prepare('DELETE FROM api_model_configs WHERE id=?').run(String(row.id)); return c.json({ ok: true }); }
    catch { return c.json({ error: { code: ErrorCodes.CREDENTIAL_DELETE_FAILED, message: 'Could not delete credentials' } }, 500); }
  });
  return { providers, configs };
}
