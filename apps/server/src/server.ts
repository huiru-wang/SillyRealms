import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { createApp } from './app.js';
import { openDatabase, recoverInterrupted } from './infrastructure/database/database.js';

const dataDir = process.env.SILLYREALMS_DATA_DIR ?? join(homedir(), '.local', 'share', 'sillyrealms');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const port = Number(process.env.PORT ?? '3000');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const release = await lockfile.lock(dataDir, { stale: 10000, update: 2000, retries: 0, onCompromised: () => { console.error('Data directory lock compromised'); process.exit(1); } });
let db: ReturnType<typeof openDatabase>;
try { db = openDatabase(join(dataDir, 'sillyrealms.sqlite')); recoverInterrupted(db); }
catch (err) { await release(); throw err; }
const server = serve({ fetch: createApp(db).fetch, hostname: '127.0.0.1', port });
console.log(`SillyRealms server listening on 127.0.0.1:${port}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close(() => { db.close(); void release(); }));
