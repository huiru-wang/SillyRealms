import { getRequestListener } from '@hono/node-server';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createApp, type AppOptions } from './app.js';
import { EventHub } from './events/event-hub.js';

export async function startServer({
  port = 3001,
  events = new EventHub(),
  canAccessSession,
}: Partial<AppOptions> & { port?: number } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid SERVER_V2_PORT');
  const app = createApp({ events, canAccessSession });
  const server = createServer(getRequestListener(app.fetch, { overrideGlobalObjects: false }));
  const listening = once(server, 'listening');
  server.listen(port, '127.0.0.1');
  await listening;

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    app.shutdown();
    closing = new Promise<void>((resolve, reject) => {
      // Let SSE finish normally; bound shutdown if a client stops reading.
      const deadline = setTimeout(() => server.closeAllConnections(), 3500);
      deadline.unref();
      server.close(error => {
        clearTimeout(deadline);
        if (error) reject(error); else resolve();
      });
      server.closeIdleConnections();
    });
    return closing;
  };
  return { server, events, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const running = await startServer({ port: Number(process.env.SERVER_V2_PORT ?? '3001') });
    const address = running.server.address();
    if (address && typeof address !== 'string') console.log(`Server V2: http://127.0.0.1:${address.port}`);
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
