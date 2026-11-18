import { Hono } from 'hono';
import type { EventHub } from './events/event-hub.js';
import type { SessionAccessCheck } from './http/session-access.js';
import { errorHandler, failure, success } from './http/response.js';
import { createModelRoutes } from './routes/models.js';
import { createPresetRoutes } from './routes/presets.js';
import { createSessionRoutes } from './routes/sessions.js';
import { createSettingsRoutes } from './routes/settings.js';
import { createStateRoutes } from './routes/state.js';
import { createTagRoutes, createWorldRoutes } from './routes/worlds.js';
import type { Services } from './services.js';

export type AppOptions = {
  events: EventHub;
  services?: Services;
  canAccessSession?: SessionAccessCheck;
};

export function createApp({ events, services, canAccessSession }: AppOptions) {
  const app = new Hono();
  const shutdown = new AbortController();
  app.use('*', async (c, next) => {
    if (shutdown.signal.aborted) return failure(c, 'SERVER_SHUTTING_DOWN');
    await next();
  });
  app.use('/api/*', async (c, next) => {
    if (!services) return failure(c, 'SERVICE_UNAVAILABLE');
    await next();
  });
  app.onError(errorHandler);
  app.notFound(c => failure(c, 'NOT_FOUND'));
  app.get('/health', c => success(c, { ok: true }));
  if (services) {
    app.route('/api/v1/presets', createPresetRoutes(services.presets));
    app.route('/api/v1/api-model-configs', createModelRoutes(services.models));
    app.route('/api/v1/app-settings', createSettingsRoutes(services.settings));
    app.route('/api/v1/worlds', createWorldRoutes({ worlds: services.worlds, sessions: services.sessions }));
    app.route('/api/v1/tags', createTagRoutes(services.worlds));
    app.route('/api/v1/sessions', createSessionRoutes({
      sessions: services.sessions, worlds: services.worlds, events, canAccessSession, shutdownSignal: shutdown.signal,
    }));
    app.route('/api/v1', createStateRoutes({
      state: services.state, sessions: services.sessions, canAccessSession, shutdownSignal: shutdown.signal,
    }));
  }
  return Object.assign(app, { shutdown: () => shutdown.abort() });
}
