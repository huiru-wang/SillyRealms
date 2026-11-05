import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { DatabaseSync } from 'node:sqlite';
import { AgentRuntime } from './agent/runtime.js';
import { PiGateway, type ModelGateway } from './agent/gateway.js';
import { runRoutes } from './routes/runs.js';
import { worldRoutes } from './routes/worlds.js';
import { tagRoutes } from './routes/tags.js';
import { providerRoutes } from './routes/providers.js';
import { MacKeychainStore, type CredentialStore } from './infrastructure/credentials/store.js';
import { presetRoutes } from './routes/presets.js';
import { sessionRoutes } from './routes/sessions.js';

export function createApp(db: DatabaseSync, credentials: CredentialStore = new MacKeychainStore(), gateway: ModelGateway = new PiGateway()): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    if (origin) {
      let url: URL;
      try { url = new URL(origin); } catch { return c.json({ error: { code: 'ORIGIN_FORBIDDEN', message: 'Invalid origin' } }, 403); }
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) {
        return c.json({ error: { code: 'ORIGIN_FORBIDDEN', message: 'Origin is not allowed' } }, 403);
      }
    }
    await next();
  });
  app.use('/api/*', bodyLimit({maxSize:11 * 1024 * 1024,onError:c => c.json({error:{code:'BODY_TOO_LARGE',message:'Request is too large'}},413)}));
  const provider = providerRoutes(db, credentials, gateway);
  const runtime = new AgentRuntime(db, credentials, gateway);
  app.route('/api/v1', runRoutes(runtime));
  app.route('/api/v1/providers', provider.providers);
  app.route('/api/v1/api-model-configs', provider.configs);
  app.route('/api/v1/tags', tagRoutes(db));
  app.route('/api/v1/worlds', worldRoutes(db, (worldId, ids, remove) => runtime.deleteWorld(worldId,ids,remove)));
  app.route('/api/v1/presets', presetRoutes(db));
  app.route('/api/v1/sessions', sessionRoutes(db, id => runtime.busy(id), (ids, remove) => runtime.deleteSessions(ids,remove), id => runtime.worldDeleting(id)));
  app.get('/health', (c) => {
    db.prepare('SELECT 1').get();
    return c.json({ ok: true });
  });
  return app;
}
