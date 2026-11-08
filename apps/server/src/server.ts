import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';
import { createApp } from './app.js';
import { openDatabase, recoverInterrupted } from './infrastructure/database/database.js';

const dataDir = process.env.SILLYREALMS_DATA_DIR ?? fileURLToPath(new URL('../../../db/', import.meta.url));
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const port = Number(process.env.PORT ?? '3000');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const release = await lockfile.lock(dataDir, { stale: 10000, update: 2000, retries: 0, onCompromised: () => { console.error('Data directory lock compromised'); process.exit(1); } });
let db: ReturnType<typeof openDatabase>;
try { db = openDatabase(join(dataDir, 'sillyrealms.sqlite')); recoverInterrupted(db); }
catch (err) { await release(); throw err; }
const app=createApp(db);
const webDir=fileURLToPath(new URL('../../web/dist/', import.meta.url));
if (existsSync(webDir)) {
  app.use('/assets/message-matcher.worker-*',async (c,next)=>{await next();c.header('Content-Security-Policy',"default-src 'none'; script-src 'self'; connect-src 'none'");});
  app.use('*',async (c,next)=>{await next();if (!c.req.path.startsWith('/api/')) c.header('Access-Control-Allow-Origin','*');});
  app.use('*',serveStatic({root:webDir}));
  app.get('*',async (c,next)=>{if(c.req.path.startsWith('/api/')||c.req.path==='/health')return next();return serveStatic({path:join(webDir,'index.html')})(c,next);});
}
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port });
console.log(`SillyRealms server listening on 127.0.0.1:${port}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close(() => { db.close(); void release(); }));
