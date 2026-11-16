/** Explicit offline conversion. Omit --apply (or pass --dry-run) to validate without writes. */
import { constants, copyFileSync, existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { migratePresetV2, PresetMigrationError } from '../src/domain/preset/migrate-v2.js';

const usage = 'Usage: pnpm --filter @sillyrealms/server migrate:presets (--file FILE [--output FILE] | --database DB) [--apply | --dry-run]';

function parseJSON(text: string, location: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new PresetMigrationError(location + ': Invalid JSON'); }
}

function existingFile(path: string): string {
  const resolved = realpathSync(resolve(path));
  if (!statSync(resolved).isFile()) throw Error('Expected a file: ' + resolved);
  return resolved;
}

async function migrateFile(source: string, output: string | undefined, apply: boolean) {
  const path = existingFile(source);
  let destination = output ? resolve(output) : path;
  if (existsSync(destination)) {
    if (realpathSync(destination) !== path) throw Error('Output already exists; choose a new output path');
    destination = path;
  }
  const release = await lockfile.lock(path, { stale: 10000, update: 2000, retries: 0 });
  let temporary: string | undefined;
  try {
    const result = migratePresetV2(parseJSON(readFileSync(path, 'utf8'), path), path);
    let backup: string | undefined, written = false;
    if (apply && (result.changed || destination !== path)) {
      backup = path + '.before-preset-templates-' + Date.now() + '-' + randomUUID() + '.json';
      copyFileSync(path, backup, constants.COPYFILE_EXCL);
      const content = JSON.stringify(result.preset, null, 2) + '\n';
      if (destination === path) {
        temporary = path + '.converting-' + randomUUID();
        writeFileSync(temporary, content, { flag: 'wx', mode: statSync(path).mode });
        renameSync(temporary, path);
        temporary = undefined;
      } else {
        writeFileSync(destination, content, { flag: 'wx' });
      }
      written = true;
    }
    console.log(JSON.stringify({ mode: 'file', dryRun: !apply, source: path, output: destination, changed: result.changed, written, backup }));
  } finally {
    if (temporary) rmSync(temporary, { force: true });
    await release();
  }
}

async function migrateDatabase(source: string, apply: boolean) {
  const path = existingFile(source), directory = dirname(path);
  const release = await lockfile.lock(directory, { stale: 10000, update: 2000, retries: 0 });
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: !apply });
    if (Number(db.prepare('PRAGMA user_version').get()!.user_version) !== 6) throw Error('Expected database schema v6; no data changed');
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
    const rows = db.prepare('SELECT id,name,description,model_parameters,context_strategy,config_json,updated_at FROM presets ORDER BY id').all();
    const updates: Array<{ id: string; original: string; config: string; updatedAt: number }> = [];
    for (const row of rows) {
      const location = 'preset[' + String(row.id) + ']';
      const result = migratePresetV2({
        name: row.name,
        description: row.description,
        model_parameters: parseJSON(String(row.model_parameters), location + '.model_parameters'),
        context_strategy: parseJSON(String(row.context_strategy), location + '.context_strategy'),
        config_json: parseJSON(String(row.config_json), location + '.config_json'),
      }, location);
      if (result.changed) updates.push({ id: String(row.id), original: String(row.config_json), config: JSON.stringify(result.preset.config_json), updatedAt: Number(row.updated_at) });
    }
    let backup: string | undefined;
    if (apply && updates.length) {
      backup = path + '.before-preset-templates-' + Date.now() + '-' + randomUUID() + '.sqlite';
      db.prepare('VACUUM INTO ?').run(backup);
      db.exec('BEGIN IMMEDIATE');
      try {
        const update = db.prepare('UPDATE presets SET config_json=?,updated_at=? WHERE id=? AND config_json=? AND updated_at=?');
        for (const item of updates) {
          const result = update.run(item.config, Math.max(Date.now(), item.updatedAt + 1), item.id, item.original, item.updatedAt);
          if (Number(result.changes) !== 1) throw Error('Preset changed during conversion: ' + item.id);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    console.log(JSON.stringify({ mode: 'database', dryRun: !apply, database: path, scanned: rows.length, converted: updates.length, applied: apply ? updates.length : 0, backup }));
  } finally {
    db?.close();
    await release();
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    file: { type: 'string' },
    database: { type: 'string' },
    output: { type: 'string' },
    apply: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    help: { type: 'boolean' },
  }, strict: true, allowPositionals: false });
  if (values.help) { console.log(usage); return; }
  if ((!values.file && !values.database) || (values.file && values.database) || (values.output && !values.file) || (values.apply && values['dry-run'])) throw Error(usage);
  if (values.file) await migrateFile(values.file, values.output, !!values.apply);
  else await migrateDatabase(values.database!, !!values.apply);
}

await main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Preset conversion failed');
  process.exitCode = 1;
});
