import { DatabaseSync } from 'node:sqlite';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';
import { compactRunMetadata } from '../src/infrastructure/database/compact-run-metadata.js';
const dir = resolve(process.env.SILLYREALMS_DATA_DIR ?? fileURLToPath(new URL('../../../db/', import.meta.url)));
const release = await lockfile.lock(dir, { stale: 10000, update: 2000, retries: 0 });
try {
  const db = new DatabaseSync(join(dir, 'sillyrealms.sqlite'));
  try {
    if (Number(db.prepare('PRAGMA user_version').get()!.user_version) !== 6) throw Error('Expected schema v6');
    const backup = join(dir, 'before-run-metadata-' + Date.now() + '.sqlite');
    db.prepare('VACUUM INTO ?').run(backup);
    console.log(JSON.stringify({ backup, ...compactRunMetadata(db) }));
  } finally { db.close(); }
} finally { await release(); }
