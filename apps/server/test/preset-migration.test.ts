import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import lockfile from 'proper-lockfile';
import { migratePresetV2, type LegacyPreset } from '../src/domain/preset/migrate-v2.js';
import { presetSchema } from '../src/domain/preset/schema.js';
import { parsePromptTemplate } from '../src/domain/preset/template.js';
import { openDatabase } from '../src/infrastructure/database/database.js';
import { seedSession } from './fixtures/db-seed.js';

type OldNode = LegacyPreset['config_json']['nodes'][number];
type OldPart = OldNode['prompt']['parts'][number];
const text = (value: string): OldPart => ({ type: 'text', value });
const source = (name: string): OldPart => ({ type: 'source', name });
const node = (id: string, parts: OldPart[], kind: OldNode['kind'] = 'system', role: OldNode['role'] = 'system'): OldNode =>
  ({ id, name: id, kind, role, enabled: true, prompt: { parts } });

function legacyPreset(): LegacyPreset {
  return {
    name: 'Legacy preset',
    description: 'Preserve this description',
    model_parameters: { temperature: 0.75, thinking_enabled: true },
    context_strategy: { strategy: 'rolling_summary', max_context_tokens: 32768, max_output_tokens: 2048, summary_prompt: 'Summarize only.' },
    config_json: { schemaVersion: 2, nodes: [
      node('main', [text('Narrate.')]),
      node('personaInfo', [text('<用户信息>\n'), source('persona.prompt'), text('\n</用户信息>')]),
      node('characterInfo', [source('characters.prompts')]),
      node('worldInfo', [source('world.lore')]),
      node('chatHistory', [
        text('<会话背景>\n'), source('session.background'), text('\n</会话背景>\n\n<已有摘要>\n'),
        source('history.summary'), text('\n</已有摘要>'), source('history.messages'),
      ], 'system', 'auto'),
      node('userInput', [source('input.text')], 'system', 'user'),
      node('worldState', [source('state.currentValues'), text('\nRules:\n'), source('state.updateRules')], 'postprocess'),
      node('actionSuggestions', [text('Suggest three actions.')], 'postprocess'),
    ] },
  };
}

const cli = (...args: string[]) => spawnSync(process.execPath,
  ['--import', 'tsx', fileURLToPath(new URL('../scripts/migrate-preset-templates.ts', import.meta.url)), ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const report = (result: ReturnType<typeof cli>) => {
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim()) as { converted?: number; applied?: number; dryRun: boolean; backup?: string; written?: boolean };
};
const backupFiles = (directory: string) => readdirSync(directory).filter(name => name.includes('.before-preset-templates-'));
function readDatabase<T>(path: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return read(db); } finally { db.close(); }
}
const preservedTables = ['worlds', 'sessions', 'entries', 'run_preparations', 'api_model_configs', 'app_settings', 'tags', 'tag_assignments'];
const preserved = (db: DatabaseSync) => Object.fromEntries(preservedTables.map(table => [table, db.prepare('SELECT * FROM ' + table).all()]));
function seedLegacy(path: string, second = false) {
  const db = openDatabase(path), old = legacyPreset();
  db.prepare('UPDATE presets SET config_json=?,updated_at=7').run(JSON.stringify(old.config_json));
  if (second) db.prepare("INSERT INTO presets SELECT 'z-second','Second',description,model_parameters,context_strategy,config_json,created_at,updated_at FROM presets WHERE id='sr-default-preset'").run();
  seedSession(db, 'session', 'world', null, 'p', null, 'Keep me', '{"chapter":"second"}', 1, 2);
  db.prepare("INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,timestamp,payload,state,ext_data) VALUES('entry','session',NULL,'opening',1,'message','assistant',1,?,NULL,'{}')").run('{"text":"Keep the story."}');
  db.prepare("UPDATE sessions SET tip_entry_id='entry' WHERE id='session'").run();
  db.prepare("INSERT INTO run_preparations(run_id,session_id,request_id,expected_tip_entry_id,input_text,status,created_at,result_json) VALUES('preparation','session','request','entry','Keep accepted input.','failed',1,'{}')").run();
  return db;
}

it('converts sources to templates and removes only the default session background block', () => {
  const old = legacyPreset(), original = structuredClone(old);
  old.tags = ['retained'];
  const result = migratePresetV2(old, 'legacy');
  expect(result.changed).toBe(true);
  const { tags, ...preset } = result.preset;
  expect(tags).toEqual(['retained']);
  expect(presetSchema.safeParse(preset).success).toBe(true);
  expect(preset.config_json.schemaVersion).toBe(3);
  expect(preset.config_json.nodes.map(item => item.id)).toEqual(original.config_json.nodes.map(item => item.id));
  expect(preset.config_json.nodes.find(item => item.id === 'chatHistory')?.prompt)
    .toBe('<已有摘要>\n{{history.summary}}\n</已有摘要>\n{{history.messages}}');
  expect(preset.config_json.nodes.find(item => item.id === 'worldState')?.prompt)
    .toBe('{{state.currentValues}}\nRules:\n{{state.updateRules}}');
  expect(JSON.stringify(preset)).not.toContain('session.background');
  expect({ ...old, tags: undefined }).toEqual({ ...original, tags: undefined });
  expect(preset.model_parameters).toEqual(old.model_parameters);
  expect(preset.context_strategy).toEqual(old.context_strategy);
  expect(migratePresetV2(result.preset)).toEqual({ changed: false, preset: result.preset });
});

it('preserves literal braces and backslashes without creating new variables, while retaining the user macro', () => {
  const old = legacyPreset(), slash = String.fromCharCode(92);
  old.config_json.nodes.splice(1, 0, node('custom', [
    text('literal {{persona.prompt}} and {{unknown}}; path C:' + slash + 'docs' + slash + '{{example}}; player {{user}}. '),
    text('{'), text('{user}}'),
  ], 'text'));
  const result = migratePresetV2(old);
  expect(result.preset.config_json.nodes.find(item => item.id === 'custom')?.prompt).toBe(
    'literal ' + slash + '{{persona.prompt}} and ' + slash + '{{unknown}}; path C:' + slash + slash + 'docs'
    + slash + slash + slash + '{{example}}; player {{user}}. ' + slash + '{{user}}');
  const expanded = parsePromptTemplate(result.preset.config_json.nodes.find(item => item.id === 'custom')!.prompt)
    .map(segment => segment.type === 'text' ? segment.value : 'Player').join('');
  expect(expanded).toBe('literal {{persona.prompt}} and {{unknown}}; path C:' + slash + 'docs' + slash + '{{example}}; player Player. {{user}}');
  old.config_json.nodes[1]!.prompt.parts = [text('{'), source('persona.prompt')];
  expect(() => migratePresetV2(old, 'braces')).toThrow('braces.nodes[custom].prompt.parts[1]');
});

it('refuses ambiguous customized background removal with a node and part location', () => {
  const old = legacyPreset(), history = old.config_json.nodes.find(item => item.id === 'chatHistory')!;
  history.prompt.parts[0] = text('A custom background title that must not disappear: ');
  const original = structuredClone(old);
  expect(() => migratePresetV2(old, 'my-preset')).toThrow('my-preset.nodes[chatHistory].prompt.parts[1]');
  expect(old).toEqual(original);
});

it('converts a JSON file only on apply, keeps its original, backs up, and is idempotent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sr-preset-file-'));
  try {
    const input = join(directory, 'old.json'), output = join(directory, 'new.json'), original = JSON.stringify(legacyPreset());
    writeFileSync(input, original);
    const dry = report(cli('--file', input, '--output', output, '--dry-run'));
    expect(dry.dryRun).toBe(true); expect(dry.written).toBe(false); expect(readdirSync(directory)).toEqual(['old.json']);
    const applied = report(cli('--file', input, '--output', output, '--apply'));
    expect(applied.written).toBe(true); expect(applied.backup).toBeTruthy();
    expect(readFileSync(input, 'utf8')).toBe(original);
    expect(readFileSync(applied.backup!, 'utf8')).toBe(original);
    expect(JSON.parse(readFileSync(output, 'utf8')).config_json.schemaVersion).toBe(3);
    const count = backupFiles(directory).length;
    expect(report(cli('--file', output, '--apply')).written).toBe(false);
    expect(backupFiles(directory)).toHaveLength(count);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 15000);

it('locks and backs up the database, preserving all IDs, references, histories and non-config preset fields', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sr-preset-db-')), path = join(directory, 'sillyrealms.sqlite');
  try {
    const db = seedLegacy(path), before = db.prepare('SELECT * FROM presets').all(), other = preserved(db);
    db.close();
    const release = await lockfile.lock(directory, { stale: 10000, update: 2000, retries: 0 });
    try { expect(cli('--database', path, '--apply').status).not.toBe(0); }
    finally { await release(); }
    expect(backupFiles(directory)).toEqual([]);
    expect(report(cli('--database', path)).applied).toBe(0);
    expect(readDatabase(path, connection => connection.prepare('SELECT * FROM presets').all())).toEqual(before);
    expect(backupFiles(directory)).toEqual([]);
    const applied = report(cli('--database', path, '--apply'));
    expect(applied.applied).toBe(1);
    readDatabase(path, connection => {
      const after = connection.prepare('SELECT * FROM presets').all();
      expect(after.map((row, index) => ({ ...row, config_json: before[index]!.config_json, updated_at: before[index]!.updated_at }))).toEqual(before);
      expect(Number(after[0]!.updated_at)).toBeGreaterThan(7);
      expect(JSON.parse(String(after[0]!.config_json)).schemaVersion).toBe(3);
      expect(preserved(connection)).toEqual(other);
      expect(connection.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(Number(connection.prepare('PRAGMA user_version').get()!.user_version)).toBe(6);
    });
    expect(readDatabase(applied.backup!, connection => connection.prepare('SELECT * FROM presets').all())).toEqual(before);
    expect(readDatabase(applied.backup!, preserved)).toEqual(other);
    expect(report(cli('--database', path, '--apply')).converted).toBe(0);
    expect(backupFiles(directory)).toHaveLength(1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 20000);

it('validates every record before writing and rolls back all preset changes on an update failure', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sr-preset-rollback-')), path = join(directory, 'sillyrealms.sqlite');
  try {
    const db = seedLegacy(path, true), original = db.prepare('SELECT * FROM presets ORDER BY id').all();
    const invalid = legacyPreset();
    invalid.config_json.nodes.find(item => item.id === 'chatHistory')!.prompt.parts[0] = text('Keep custom wording');
    db.prepare("UPDATE presets SET config_json=? WHERE id='z-second'").run(JSON.stringify(invalid.config_json));
    const beforeInvalid = db.prepare('SELECT * FROM presets ORDER BY id').all();
    db.close();
    const failedValidation = cli('--database', path, '--apply');
    expect(failedValidation.status).not.toBe(0);
    expect(failedValidation.stderr).toContain('preset[z-second].nodes[chatHistory]');
    expect(readDatabase(path, connection => connection.prepare('SELECT * FROM presets ORDER BY id').all())).toEqual(beforeInvalid);
    expect(backupFiles(directory)).toEqual([]);
    const writable = new DatabaseSync(path);
    writable.prepare("UPDATE presets SET config_json=? WHERE id='z-second'").run(String(original[1]!.config_json));
    writable.exec("CREATE TRIGGER reject_second BEFORE UPDATE ON presets WHEN OLD.id='z-second' BEGIN SELECT RAISE(ABORT,'blocked update'); END");
    writable.close();
    expect(cli('--database', path, '--apply').status).not.toBe(0);
    expect(readDatabase(path, connection => connection.prepare('SELECT * FROM presets ORDER BY id').all())).toEqual(original);
    expect(backupFiles(directory)).toHaveLength(1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 15000);
