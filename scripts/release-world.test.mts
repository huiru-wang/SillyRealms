import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectWorldSource } from '../apps/server/src/modules/worlds/service.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = join(root, 'scripts/release-world.ts');
const serverRequire = createRequire(new URL('../apps/server/package.json', import.meta.url));
const loader = serverRequire.resolve('tsx');
const packageId = '8da0e392-2ea6-4ac1-a93a-b94abf6828a1';
const publishedAt = '2026-11-26T12:00:00+08:00';

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(join(tmpdir(), 'sr-release-cli-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const directory = join(temporary, 'world');
  await mkdir(directory);
  const card = {
    spec_version: '0.2',
    data: {
      name: '测试旅店',
      publication: {
        package_id: packageId, authors: [{ name: '旅店作者' }],
        creator_notes: '作品说明与更新说明分别保存。', homepage: 'https://example.org/inn',
        update_url: 'https://cdn.example.org/inn/releases.json',
        release: { version: '1.0.0', published_at: '2026-01-01T00:00:00Z', notes: '源卡版本' },
      },
      characters: [{ id: 'traveler', name: '旅人', player_selectable: true }],
      openings: [{ id: 'arrival', name: '抵达', content: '你推开旅店的门。' }],
    },
  };
  const save = (value: unknown = card) => writeFile(join(directory, 'world.json'), JSON.stringify(value, null, 2) + '\n');
  await save();
  const notes = join(temporary, 'release-notes.md');
  const notesText = '## 新增\n- 港口夜巡\n\n## 修复\n- 背包展示。\n';
  await writeFile(notes, notesText, 'utf8');
  const index = join(temporary, 'releases.json');
  const output = join(temporary, 'dist');
  const args = ['--dir', relative(root, directory), '--version', '1.10.0', '--notes', notes,
    '--artifact-url', 'https://cdn.example.org/inn/versions/1.10.0/world.zip',
    '--index', index, '--out', output, '--published-at', publishedAt, '--title', '港口夜巡'];
  const zip = join(output, 'versions', '1.10.0', 'world.zip');
  return { temporary, directory, card, save, notes, notesText, index, output, args, zip };
}
function run(args: string[], temporary: string) {
  const result = spawnSync(process.execPath, ['--import', loader, script, ...args], {
    cwd: temporary, encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1', SERVER_DATA_ROOT: join(temporary, 'app-data') },
  });
  assert.equal(result.error, undefined);
  const output = result.status === 0 ? result.stdout : result.stderr;
  let report: Record<string, unknown>;
  try { report = JSON.parse(output); }
  catch { assert.fail('CLI did not return JSON: ' + output); }
  return { ...result, report };
}
async function exists(path: string) {
  try { await access(path); return true; }
  catch { return false; }
}
function replaceArgument(args: string[], name: string, value: string) {
  const updated = [...args];
  updated[updated.indexOf(name) + 1] = value;
  return updated;
}
function oldIndex() {
  return {
    schema_version: 1, package_id: packageId, community: { label: '保留扩展' },
    versions: [{
      version: '1.9.0', published_at: '2026-01-02T00:00:00Z', notes: '旧发行',
      spec_version: '0.2', attribution: '旧版本扩展',
      artifact: { format: 'zip', url: 'https://cdn.example.org/inn/versions/1.9.0/world.zip',
        sha256: 'a'.repeat(64), size_bytes: 100 },
    }],
  };
}

test('release writes the real ZIP digest and size, preserves notes/source, and uses no app data', async t => {
  const f = await fixture(t);
  await writeFile(f.index, JSON.stringify(oldIndex(), null, 2) + '\n');
  await mkdir(join(f.directory, 'assets'));
  await writeFile(join(f.directory, 'assets', 'cover.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await f.save({ ...f.card, data: { ...f.card.data, cover: 'sr-asset://assets/cover.svg' } });
  const sourceBefore = await readFile(join(f.directory, 'world.json'));
  const result = run(f.args, f.temporary);
  assert.equal(result.status, 0, result.stderr);
  const bytes = await readFile(f.zip);
  const indexText = await readFile(f.index, 'utf8');
  const index = JSON.parse(indexText);
  const entry = index.versions[0];
  assert.deepEqual(index.versions.map((row: { version: string }) => row.version), ['1.10.0', '1.9.0']);
  assert.equal(entry.artifact.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(entry.artifact.size_bytes, bytes.length);
  assert.equal(entry.published_at, publishedAt);
  assert.equal(entry.notes, f.notesText);
  assert.equal(entry.title, '港口夜巡');
  assert.equal(index.community.label, '保留扩展');
  assert.equal(index.versions[1].attribution, '旧版本扩展');
  assert.ok(indexText.endsWith('\n'));
  assert.equal(result.report.output, f.zip);
  const packed = await inspectWorldSource(f.zip);
  assert.deepEqual(packed.card.data.publication?.release, {
    version: '1.10.0', published_at: publishedAt, notes: f.notesText,
  });
  assert.equal(packed.card.data.publication?.creator_notes, f.card.data.publication.creator_notes);
  assert.equal(packed.card.data.publication?.update_url, f.card.data.publication.update_url);
  assert.deepEqual(packed.packageFiles, ['assets/cover.svg', 'world.json']);
  assert.deepEqual(await readFile(join(f.directory, 'world.json')), sourceBefore);
  assert.equal(await exists(join(f.temporary, 'app-data')), false);
  assert.equal(await exists(f.index + '.lock'), false);
});

test('duplicate versions and existing ZIP paths never overwrite published bytes', async t => {
  const f = await fixture(t);
  const first = run(f.args, f.temporary);
  assert.equal(first.status, 0, first.stderr);
  const zipBefore = await readFile(f.zip);
  const indexBefore = await readFile(f.index);
  const duplicate = run(f.args, f.temporary);
  assert.equal(duplicate.status, 1);
  assert.equal(duplicate.report.code, 'RELEASE_VERSION_EXISTS');
  assert.deepEqual(await readFile(f.zip), zipBefore);
  assert.deepEqual(await readFile(f.index), indexBefore);
  const anotherIndex = join(f.temporary, 'another-index.json');
  const existing = run(replaceArgument(f.args, '--index', anotherIndex), f.temporary);
  assert.equal(existing.status, 1);
  assert.equal(existing.report.code, 'OUTPUT_EXISTS');
  assert.deepEqual(await readFile(f.zip), zipBefore);
  assert.equal(await exists(anotherIndex), false);
});

test('release retains official asset and component checks before publishing any index or ZIP', async t => {
  const f = await fixture(t);
  await f.save({ ...f.card, data: { ...f.card.data, cover: 'sr-asset://assets/missing.svg' } });
  const missing = run(f.args, f.temporary);
  assert.equal(missing.status, 1);
  assert.match(String(missing.report.message), /missing.svg/);
  await f.save({ ...f.card, data: { ...f.card.data,
    components: [{ id: 'Stage', component: "import bad from 'missing-package'; export default function Stage(){return null;}" }],
    stage_component: 'Stage',
  } });
  const component = run(f.args, f.temporary);
  assert.equal(component.status, 1);
  assert.equal(component.report.code, 'INVALID_WORLD_COMPONENT');
  assert.equal(await exists(f.index), false);
  assert.equal(await exists(f.zip), false);
  assert.equal(await exists(f.index + '.lock'), false);
});

test('invalid release input and conflicting old indexes leave the old directory untouched', async t => {
  const f = await fixture(t);
  const previous = JSON.stringify(oldIndex(), null, 2) + '\n';
  await writeFile(f.index, previous);
  for (const [option, value] of [
    ['--version', '../escape'], ['--version', '1.2.0-beta'], ['--published-at', '2026-11-26'],
    ['--artifact-url', 'http://cdn.example.org/world.zip'],
  ]) {
    const failed = run(replaceArgument(f.args, option!, value!), f.temporary);
    assert.equal(failed.status, 1, failed.stdout);
    assert.equal(await readFile(f.index, 'utf8'), previous);
    assert.equal(await exists(f.zip), false);
  }
  const otherPackage = { ...oldIndex(), package_id: '4ae38d75-6309-4bdc-b84b-e7735447084d' };
  await writeFile(f.index, JSON.stringify(otherPackage));
  const conflict = run(f.args, f.temporary);
  assert.equal(conflict.status, 1);
  assert.equal(await readFile(f.index, 'utf8'), JSON.stringify(otherPackage));
  assert.equal(await exists(f.zip), false);
});

test('offline legacy cards cannot acquire a new identity implicitly during release', async t => {
  const f = await fixture(t);
  const { name, characters, openings } = f.card.data;
  await f.save({ spec_version: '0.1', data: { name, characters, openings } });
  const result = run(f.args, f.temporary);
  assert.equal(result.status, 1);
  assert.equal(result.report.code, 'WORLD_PUBLICATION_REQUIRED');
  assert.equal(await exists(f.index), false);
  assert.equal(await exists(f.zip), false);
});

test('index/output aliases into packaged content are refused and existing locks are respected', async t => {
  const f = await fixture(t);
  const sourceBefore = await readFile(join(f.directory, 'world.json'));
  await mkdir(join(f.directory, 'assets'));
  const alias = join(f.temporary, 'assets-alias');
  await symlink(join(f.directory, 'assets'), alias, 'dir');
  const output = run(replaceArgument(f.args, '--out', alias), f.temporary);
  assert.equal(output.status, 1);
  assert.equal(output.report.code, 'INVALID_OUTPUT');
  assert.deepEqual(await readdir(join(f.directory, 'assets')), []);
  const manifest = run(replaceArgument(f.args, '--index', join(f.directory, 'world.json')), f.temporary);
  assert.equal(manifest.status, 1);
  assert.equal(manifest.report.code, 'INVALID_OUTPUT');
  assert.deepEqual(await readFile(join(f.directory, 'world.json')), sourceBefore);
  await writeFile(f.index + '.lock', 'another writer');
  const locked = run(f.args, f.temporary);
  assert.equal(locked.status, 1);
  assert.equal(locked.report.code, 'RELEASE_INDEX_LOCKED');
  assert.equal(await readFile(f.index + '.lock', 'utf8'), 'another writer');
  assert.equal(await exists(f.index), false);
});

test('non-UTF-8 release notes fail without silently replacing author text', async t => {
  const f = await fixture(t);
  await writeFile(f.notes, Buffer.from([0xc3, 0x28]));
  const result = run(f.args, f.temporary);
  assert.equal(result.status, 1);
  assert.equal(result.report.code, 'INVALID_UTF8');
  assert.equal(await exists(f.index), false);
  assert.equal(await exists(f.zip), false);
});

test('checks the final formatted index byte size before publishing ZIP or directory', async t => {
  const f = await fixture(t);
  const previous = JSON.stringify({ ...oldIndex(), extension: Array(350_000).fill(0) });
  assert.ok(Buffer.byteLength(previous, 'utf8') < 2 * 1024 * 1024);
  await writeFile(f.index, previous);
  const result = run(f.args, f.temporary);
  assert.equal(result.status, 1);
  assert.equal(result.report.code, 'INVALID_WORLD_RELEASE_INDEX');
  assert.match(String(result.report.message), /2 MiB/);
  assert.equal(await readFile(f.index, 'utf8'), previous);
  assert.equal(await exists(f.zip), false);
  assert.equal(await exists(f.index + '.lock'), false);
});
