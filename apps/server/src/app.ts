import { ErrorCodes } from './common/error-codes.js';
import { Hono } from 'hono';
import { debugLog } from './common/debug.js';
import { bodyLimit } from 'hono/body-limit';
import type { DatabaseSync } from 'node:sqlite';
import { AgentRuntime, PiGateway, type ModelGateway } from './agent/index.js';
import { worldRoutes } from './routes/worlds.js';
import { appSettingsRoutes } from './routes/app-settings.js';
import { WorldFileStore, testWorldDataDir } from './infrastructure/world-files/world-file-store.js';
import { tagRoutes } from './routes/tags.js';
import { providerRoutes } from './routes/providers.js';
import { MacKeychainStore, type CredentialStore } from './infrastructure/credentials/store.js';
import { presetRoutes } from './routes/presets.js';
import { sessionRuntimeRoutes } from './routes/session-runtime.js';
import { stateUpdateRoutes } from './routes/state-updates.js';
import { responseEnvelope } from './common/response-middleware.js';
import { failure } from './common/http-response.js';
import { sessionRoutes } from './routes/sessions.js';

export function createApp(db: DatabaseSync, credentials: CredentialStore = new MacKeychainStore(), gateway: ModelGateway = new PiGateway(), files: WorldFileStore = new WorldFileStore(testWorldDataDir()), allowedOrigins: ReadonlySet<string> = new Set()): Hono {
  const app = new Hono();
  app.use('*', responseEnvelope);
  app.onError((_error,c)=>c.json(failure(ErrorCodes.INTERNAL_ERROR),500));
  app.notFound(c=>c.req.path.startsWith('/api/')?c.json(failure(ErrorCodes.NOT_FOUND),404):c.text('Not Found',404));
  app.use('/api/*', async (c,next)=>{const start=Date.now();try{await next();}finally{debugLog('会话 API',{method:c.req.method,path:c.req.path,query:c.req.query(),status:c.res.status,durationMs:Date.now()-start});}});
  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    if (origin && !(origin === 'null' && c.req.method === 'GET' && !c.req.path.startsWith('/api/'))) {
      let url: URL;
      try { url = new URL(origin); } catch { return c.json(failure(ErrorCodes.ORIGIN_FORBIDDEN),403); }
      if ((!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) && !allowedOrigins.has(origin)) {
        return c.json(failure(ErrorCodes.ORIGIN_FORBIDDEN),403);
      }
    }
    await next();
  });
  app.use('/api/*', bodyLimit({maxSize:11 * 1024 * 1024,onError:c => c.json(failure(ErrorCodes.BODY_TOO_LARGE, '请求内容超过 11 MiB', { path: '$' }),413)}));
  const provider = providerRoutes(db, credentials, gateway);
  const runtime = new AgentRuntime(db, credentials, gateway);
  app.route('/api/v1/sessions', sessionRuntimeRoutes(db,runtime));
  app.route('/api/v1/sessions', stateUpdateRoutes(db,runtime));
  app.route('/api/v1/providers', provider.providers);
  app.route('/api/v1/api-model-configs', provider.configs);
  app.route('/api/v1/tags', tagRoutes(db));
  app.route('/api/v1/worlds', worldRoutes(db, (worldId, ids, remove) => runtime.deleteWorld(worldId,ids,remove), files));
  app.route('/api/v1/app-settings', appSettingsRoutes(db));
  app.route('/api/v1/presets', presetRoutes(db));
  const sessions=sessionRoutes(db, id => runtime.busy(id), (ids, remove) => runtime.deleteSessions(ids,remove), id => runtime.worldDeleting(id), id => runtime.emit(id,'session.updated',{}), credentials);
  app.route('/api/v1/sessions', sessions);
  app.get('/health', (c) => {
    db.prepare('SELECT 1').get();
    return c.json({ ok: true });
  });
  return app;
}
