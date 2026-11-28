import { getRequestListener } from '@hono/node-server';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp, type AppOptions } from './app.js';
import { openDatabase } from './infrastructure/database/connection.js';
import { bindTransaction } from './infrastructure/database/transaction.js';
import { EventHub } from './infrastructure/events/event-hub.js';
import type { CredentialStore } from './modules/credentials/service.js';
import { createServices } from './services.js';
import { createUsecases } from './usecases.js';

export type ServerOptions = Partial<Pick<AppOptions, 'events' | 'canAccessSession' | 'webOrigin' | 'stageOrigin' | 'debug'>> & {
  port?: number;
  dataRoot?: string;
  databasePath?: string;
  credentialStore?: CredentialStore;
};

export async function startServer({
  port = 3001,
  dataRoot = fileURLToPath(new URL('../../../data/', import.meta.url)),
  databasePath,
  events = new EventHub(),
  canAccessSession,
  credentialStore,
  webOrigin, stageOrigin, debug,
}: ServerOptions = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid SERVER_PORT');
  if (!dataRoot.trim()) throw new Error('Invalid SERVER_DATA_ROOT');
  const root = resolve(dataRoot);
  const database = openDatabase(databasePath ?? join(root, 'database.sqlite'));
  try {
    const services = createServices(database, root, credentialStore);
    const usecases = createUsecases({ services, transaction: bindTransaction(database), events });
    services.sessions.recoverInterruptedRuns();
    await usecases.initialize();
    const app = createApp({ events, services, usecases, canAccessSession, webOrigin, stageOrigin, debug });
    const server = createServer(getRequestListener(app.fetch, { overrideGlobalObjects: false }));
    const listening = once(server, 'listening');
    try {
      server.listen(port, '127.0.0.1');
      await listening;
    } catch (error) {
      await app.shutdown();
      throw error;
    }

    void usecases.worldUpdates.checkAtStartup().catch(error => console.warn('WORLD_UPDATE_STARTUP_FAILED', error));

    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (closing) return closing;
      closing = app.shutdown().finally(() => new Promise<void>((resolveClose, reject) => {
        // Finish SSE before releasing the shared database; bound shutdown for stalled clients.
        const deadline = setTimeout(() => server.closeAllConnections(), 3500);
        deadline.unref();
        server.close(error => {
          clearTimeout(deadline);
          if (error) reject(error); else resolveClose();
        });
        server.closeIdleConnections();
      })).finally(() => database.close());
      return closing;
    };
    usecases.storageFailure.addEventListener('abort', () => {
      void close().catch(error => console.error('SERVER_SHUTDOWN_FAILED', error));
    }, { once: true });
    return { server, events, services, usecases, close };
  } catch (error) {
    database.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const running = await startServer({
      port: Number(process.env.SERVER_PORT ?? '3001'),
      dataRoot: process.env.SERVER_DATA_ROOT,
      webOrigin: process.env.SERVER_WEB_ORIGIN,
      stageOrigin: process.env.SERVER_STAGE_ORIGIN,
      debug: process.argv.slice(2).includes('--debug') || process.env.SERVER_DEBUG === 'true',
    });
    running.usecases.storageFailure.addEventListener('abort', () => { process.exitCode = 1; }, { once: true });
    const address = running.server.address();
    if (address && typeof address !== 'string') console.log('Server: http://127.0.0.1:' + address.port);
    const stop = () => {
      void running.close().catch(error => {
        console.error('SERVER_SHUTDOWN_FAILED', error);
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    console.error('SERVER_START_FAILED', error);
    process.exitCode = 1;
  }
}
