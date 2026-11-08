#!/usr/bin/env node
/**
 * Explicitly reset only the SR-managed SQLite DB and imported-world files.
 * Stops at an active application lock. Never removes the data directory itself.
 *
 * Usage: node scripts/reset-sr-data.mjs --yes
 * Optional: SILLYREALMS_DATA_DIR=/safe/path node scripts/reset-sr-data.mjs --yes
 */
import { lstat, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(fileURLToPath(new URL('../apps/server/package.json', import.meta.url)));
const lockfile = require('proper-lockfile');

if (process.argv.length!==3 || process.argv[2]!=='--yes') {
  console.error('Usage: node scripts/reset-sr-data.mjs --yes');
  process.exit(2);
}
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const dataDir=resolve(process.env.SILLYREALMS_DATA_DIR ?? join(root,'db'));
if (dataDir === '/' || dataDir === root || dirname(dataDir)===dataDir) throw new Error('Unsafe SR data directory');
const stat=await lstat(dataDir).catch(e=>e.code==='ENOENT'?null:Promise.reject(e));
if (stat?.isSymbolicLink()) throw new Error('Refusing symlink data directory');
if (!stat) {console.log('SR data directory does not exist; nothing to reset');process.exit(0);}
if (!stat.isDirectory()) throw new Error('SR data root is not a directory');
if (await lockfile.check(dataDir)) throw new Error('SR server is running. Stop it before resetting data.');
for (const parent of ['workspaces','workspaces/worlds']) {
  const st=await lstat(join(dataDir,parent)).catch(e=>e.code==='ENOENT'?null:Promise.reject(e));
  if (st?.isSymbolicLink()) throw new Error('Refusing symlink world workspace');
}
const targets=['sillyrealms.sqlite','sillyrealms.sqlite-wal','sillyrealms.sqlite-shm','workspaces/worlds'];
const deleted=[];
for (const name of targets) {
  const path=join(dataDir,name);
  const st=await lstat(path).catch(e=>e.code==='ENOENT'?null:Promise.reject(e));
  if (!st) continue;
  if (st.isSymbolicLink()) throw new Error('Refusing symlink managed target: '+name);
  if (name==='workspaces/worlds' && !st.isDirectory()) throw new Error('World workspace is not a directory');
  if (name.startsWith('sillyrealms.sqlite') && !st.isFile()) throw new Error('SQLite target is not a file');
  await rm(path,{recursive:st.isDirectory(),force:false});
  deleted.push(name);
}
console.log(JSON.stringify({dataDir,deleted,note:'Only SR database and world files reset; Keychain and unrelated data left untouched'},null,2));
