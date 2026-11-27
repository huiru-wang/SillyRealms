import { Hono } from 'hono';
import { localWebOrigins } from '../../../scripts/local-network.mjs';
import { runtimeConfig } from './http/runtime-config.js';
import type { EventHub } from './infrastructure/events/event-hub.js';
import { requireSessionAccess, type SessionAccessCheck } from './http/session-access.js';
import { characterSpriteAvailable, resolvePostprocessPrompts } from './modules/presets/service.js';
import { errorHandler, failure, success } from './http/response.js';
import { createModelRoutes } from './routes/models.js';
import { createReplyAssistRoutes } from './routes/reply-assist.js';
import { createNarrativeRoutes } from './routes/narrative.js';
import { createProviderRoutes } from './routes/providers.js';
import { createPresetRoutes } from './routes/presets.js';
import { createSessionRoutes } from './routes/sessions.js';
import { createSettingsRoutes } from './routes/settings.js';
import { createStateRoutes } from './routes/state.js';
import { createWorldRoutes } from './routes/worlds.js';
import { allowApiOrigin, parseWebOrigin } from './http/origin.js';
import type { Services } from './services.js';
import type { Usecases } from './usecases.js';

export type AppOptions = {
  events: EventHub;
  webOrigin?: string;
  stageOrigin?: string;
  debug?: boolean;
  canAccessSession?: SessionAccessCheck;
  services: Services;
  usecases: Usecases;
};

export function createApp({ events, services, usecases, canAccessSession, webOrigin, stageOrigin, debug }: AppOptions) {
  const trustedWebOrigin = parseWebOrigin(webOrigin ?? 'http://127.0.0.1:5176');
  const config = runtimeConfig({ webOrigin: trustedWebOrigin, stageOrigin, debug });
  // Vite preserves the Web Host header when proxying /api. Only pair known local listeners.
  const localConfigs = new Map((webOrigin === undefined && stageOrigin === undefined ? localWebOrigins() : [])
    .map(origin => [origin, runtimeConfig({ webOrigin: origin, debug })]));
  const app = new Hono();
  const shutdown = new AbortController(), streams = new AbortController();
  let stopping = false;
  let closing: Promise<void> | undefined;
  app.use('*', async (c, next) => {
    if (stopping) return failure(c, 'SERVER_SHUTTING_DOWN');
    await next();
  });
  app.use('/api/*', async (c, next) => {
    if (!allowApiOrigin(c.req.header('origin'), c.req.url, c.req.method, trustedWebOrigin)) return failure(c, 'ORIGIN_NOT_ALLOWED');
    await next();
  });
  app.onError(errorHandler);
  app.notFound(c => failure(c, 'NOT_FOUND'));
  app.get('/health', c => success(c, { ok: true }));
  app.get('/api/v1/runtime/config', async c => {
    c.header('Cache-Control', 'no-store');
    const deployment = localConfigs.get(new URL(c.req.url).origin) ?? config;
    const id = c.req.query('sessionId');
    if (id === undefined) return success(c, deployment);

    await requireSessionAccess(services.sessions, id, c.req.raw, canAccessSession, shutdown.signal);
    const session = services.sessions.require(id);
    const prompts = resolvePostprocessPrompts(services.presets.require(session.runtimeConfig.narrativePresetId).config);
    const catalog = services.worlds.getCharacterSpriteCatalog(session.worldId);
    return success(c, {
      ...deployment,
      capabilities: { characterSprite: { available: characterSpriteAvailable(prompts, catalog.items.length) } },
    });
  });
  app.route('/api/v1/presets', createPresetRoutes(services.presets, usecases.deletePreset));
  app.route('/api/v1/api-model-configs', createModelRoutes(
    services.models, services.credentials, usecases.modelConfigs, usecases.testModel, shutdown.signal,
  ));
  app.route('/api/v1/providers', createProviderRoutes({ listProviders: usecases.listProviders }));
  app.route('/api/v1/sessions', createReplyAssistRoutes({ sessions: services.sessions, replyAssist: usecases.replyAssist, canAccessSession, shutdownSignal: shutdown.signal }));
  app.route('/api/v1/sessions', createNarrativeRoutes({
    sessions: services.sessions, narrative: usecases.narrative, canAccessSession, shutdownSignal: shutdown.signal,
  }));
  app.route('/api/v1/app-settings', createSettingsRoutes(services.settings));
  app.route('/api/v1/worlds', createWorldRoutes({
    worlds: services.worlds, sessions: services.sessions, cache: services.cache, worldUpdates: usecases.worldUpdates,
    importWorld: usecases.importWorld, exportWorld: usecases.exportWorld,
    deleteWorld: usecases.deleteWorld, canAccessSession, shutdownSignal: shutdown.signal,
  }));
  app.route('/api/v1/sessions', createSessionRoutes({
    createSession: usecases.createSession,
    sessions: services.sessions, worlds: services.worlds, events, canAccessSession, shutdownSignal: shutdown.signal, streamShutdownSignal: streams.signal,
  }));
  app.route('/api/v1/state', createStateRoutes({
    state: usecases.state, sessions: services.sessions, canAccessSession, shutdownSignal: shutdown.signal,
  }));
  return Object.assign(app, { shutdown: (): Promise<void> => {
    if (closing) return closing;
    stopping = true;
    shutdown.abort();
    // Keep SSE alive until every accepted run has saved its already received body and published its terminal event.
    closing = Promise.all([usecases.narrative.shutdown(), usecases.replyAssist.shutdown(), usecases.worldUpdates.shutdown()]).then(() => {}).finally(() => streams.abort());
    return closing;
  } });
}
