/** Explicit breaking-change reset. Run only while the SR server is stopped.
 * Usage: pnpm --filter @sillyrealms/server reset:data
 * All deletions are limited to the selected SR data directory.
 */
import { existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';

const dataDir = resolve(process.env.SILLYREALMS_DATA_DIR ?? fileURLToPath(new URL('../../../db/', import.meta.url)));
const marker = '--confirm-reset-sr-data';
if (!process.argv.includes(marker)) {
  console.error(`Refusing destructive reset without ${marker}. Target: ${dataDir}`);
  process.exitCode = 2;
} else if (!existsSync(dataDir)) {
  console.error('SR data directory does not exist; no files changed.');
  process.exitCode = 2;
} else {
  const folder = lstatSync(dataDir);
  if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error('Unsafe SR data directory');
  const paths = ['sillyrealms.sqlite', 'sillyrealms.sqlite-wal', 'sillyrealms.sqlite-shm'];
  const worldsRoot = join(dataDir, 'workspaces');
  const worldFiles = join(worldsRoot, 'worlds');
  for (const item of paths) {
    const path = join(dataDir, item);
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe SQLite file: ${item}`);
  }
  if (existsSync(worldsRoot) && (!lstatSync(worldsRoot).isDirectory() || lstatSync(worldsRoot).isSymbolicLink()))
    throw new Error('Unsafe workspaces directory');
  if (existsSync(worldFiles) && (!lstatSync(worldFiles).isDirectory() || lstatSync(worldFiles).isSymbolicLink()))
    throw new Error('Unsafe worlds directory');
  // Uses the exact same lock as server.ts. Refuses to reset a running instance.
  const release = await lockfile.lock(dataDir, { stale: 10000, update: 2000, retries: 0 });
  try {
    for (const item of paths) rmSync(join(dataDir, item), { force: true });
    if (existsSync(worldFiles)) rmSync(worldFiles, { recursive: true, force: true });
    console.log(`SR SQLite database and world source files reset: ${dataDir}`);
    console.log('Other data-directory files and macOS Keychain entries were not changed.');
  } finally { await release(); }
}
