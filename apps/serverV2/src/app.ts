import { Hono } from 'hono';
import type { EventHub } from './infrastructure/events/event-hub.js';
import type { SessionAccessCheck } from './http/session-access.js';
import { errorHandler, failure, success } from './http/response.js';
import { createModelRoutes } from './routes/models.js';
import { createNarrativeRoutes } from './routes/narrative.js';
import { createProviderRoutes } from './routes/providers.js';
import { createPresetRoutes } from './routes/presets.js';
import { createSessionRoutes } from './routes/sessions.js';
import { createSettingsRoutes } from './routes/settings.js';
import { createStateRoutes } from './routes/state.js';
import { createWorldRoutes } from './routes/worlds.js';
import { allowApiOrigin, parseStudioOrigin } from './http/origin.js';
import type { Services } from './services.js';
import type { Usecases } from './usecases.js';

export type AppOptions = {
  events: EventHub;
  studioOrigin?: string;
  canAccessSession?: SessionAccessCheck;
} & (
  | { services: Services; usecases: Usecases }
  | { services?: undefined; usecases?: undefined }
);

export function createApp({ events, services, usecases, canAccessSession, studioOrigin = 'http://127.0.0.1:5176' }: AppOptions) {
  const trustedStudioOrigin = parseStudioOrigin(studioOrigin);
  const app = new Hono();
  const shutdown = new AbortController();
  let stopping = false;
  let closing: Promise<void> | undefined;
  app.use('*', async (c, next) => {
    if (stopping) return failure(c, 'SERVER_SHUTTING_DOWN');
    await next();
  });
  app.use('/api/*', async (c, next) => {
    if (!allowApiOrigin(c.req.header('origin'), c.req.url, c.req.method, trustedStudioOrigin)) return failure(c, 'ORIGIN_NOT_ALLOWED');
    if (!services) return failure(c, 'SERVICE_UNAVAILABLE');
    await next();
  });
  app.onError(errorHandler);
  app.notFound(c => failure(c, 'NOT_FOUND'));
  app.get('/health', c => success(c, { ok: true }));
  if (services) {
    app.route('/api/v1/presets', createPresetRoutes(services.presets, usecases));
    app.route('/api/v1/api-model-configs', createModelRoutes(
      services.models, services.credentials, usecases.modelConfigs, usecases.testModel, shutdown.signal,
    ));
    app.route('/api/v1/providers', createProviderRoutes({ listProviders: usecases.listProviders }));
    app.route('/api/v1/sessions', createNarrativeRoutes({
      sessions: services.sessions, narrative: usecases.narrative, canAccessSession, shutdownSignal: shutdown.signal,
    }));
    app.route('/api/v1/app-settings', createSettingsRoutes(services.settings));
    app.route('/api/v1/worlds', createWorldRoutes({
      worlds: services.worlds, sessions: services.sessions,
      importWorld: usecases.importWorld, exportWorld: usecases.exportWorld,
    }));
    app.route('/api/v1/sessions', createSessionRoutes({
      sessions: services.sessions, worlds: services.worlds, events, canAccessSession, shutdownSignal: shutdown.signal,
    }));
    app.route('/api/v1', createStateRoutes({
      state: services.state, setState: usecases.setState, sessions: services.sessions, canAccessSession, shutdownSignal: shutdown.signal,
    }));
  }
  return Object.assign(app, { shutdown: (): Promise<void> => {
    if (closing) return closing;
    stopping = true;
    // Keep SSE alive until every accepted run has saved its already received body and published its terminal event.
    closing = (usecases?.narrative.shutdown() ?? Promise.resolve()).finally(() => shutdown.abort());
    return closing;
  } });
}
