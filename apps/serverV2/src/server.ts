import { getRequestListener } from '@hono/node-server';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp, type AppOptions } from './app.js';
import { openDatabase } from './database/connection.js';
import { EventHub } from './events/event-hub.js';
import { createServices } from './services.js';

export type ServerOptions = Partial<Pick<AppOptions, 'events' | 'canAccessSession'>> & {
  port?: number;
  dataRoot?: string;
  databasePath?: string;
};

export async function startServer({
  port = 3001,
  dataRoot = fileURLToPath(new URL('../../../runtime/server-v2/', import.meta.url)),
  databasePath,
  events = new EventHub(),
  canAccessSession,
}: ServerOptions = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid SERVER_V2_PORT');
  if (!dataRoot.trim()) throw new Error('Invalid SERVER_V2_DATA_ROOT');
  const root = resolve(dataRoot);
  const database = openDatabase(databasePath ?? join(root, 'database.sqlite'));
  try {
    const services = createServices(database, root);
    const app = createApp({ events, services, canAccessSession });
    const server = createServer(getRequestListener(app.fetch, { overrideGlobalObjects: false }));
    const listening = once(server, 'listening');
    try {
      server.listen(port, '127.0.0.1');
      await listening;
    } catch (error) {
      app.shutdown();
      throw error;
    }

    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (closing) return closing;
      app.shutdown();
      closing = new Promise<void>((resolveClose, reject) => {
        // Finish SSE before releasing the shared database; bound shutdown for stalled clients.
        const deadline = setTimeout(() => server.closeAllConnections(), 3500);
        deadline.unref();
        server.close(error => {
          clearTimeout(deadline);
          if (error) reject(error); else resolveClose();
        });
        server.closeIdleConnections();
      }).finally(() => database.close());
      return closing;
    };
    return { server, events, services, close };
  } catch (error) {
    database.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const running = await startServer({
      port: Number(process.env.SERVER_V2_PORT ?? '3001'),
      dataRoot: process.env.SERVER_V2_DATA_ROOT,
    });
    const address = running.server.address();
    if (address && typeof address !== 'string') console.log('Server V2: http://127.0.0.1:' + address.port);
    const stop = () => {
      void running.close().catch(error => {
        console.error('SERVER_V2_SHUTDOWN_FAILED', error);
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    console.error('SERVER_V2_START_FAILED', error);
    process.exitCode = 1;
  }
}
