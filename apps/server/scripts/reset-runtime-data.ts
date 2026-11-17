/** Explicit v6 -> v7 reset. Old worlds, state and presets are discarded; source files and credentials stay untouched. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetRuntimeData } from '../src/infrastructure/database/runtime-reset.js';

const dir = resolve(process.env.SILLYREALMS_DATA_DIR ?? fileURLToPath(new URL('../../../db/', import.meta.url)));
try {
  console.log(JSON.stringify(await resetRuntimeData(dir, process.argv.includes('--confirm-reset-runtime'))));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Runtime reset failed');
  process.exitCode = 1;
}
