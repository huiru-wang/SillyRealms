import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { inspectWorldSource } from '../apps/server/src/modules/worlds/service.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = join(root, 'scripts/world-card.mts');
const serverRequire = createRequire(new URL('../apps/server/package.json', import.meta.url));
const loader = serverRequire.resolve('tsx');
const { ZipFile } = serverRequire('yazl');

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(join(tmpdir(), 'sr-world-cli-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const directory = join(temporary, 'world');
  await mkdir(directory);
  const card = {
    spec_version: '0.2',
    data: {
      name: '测试旅店',
      publication: {
        package_id: 'f52b3090-3d5f-4d09-89b4-b6507cb1a4f6',
        authors: [{ name: '测试作者' }],
        release: { version: '1.0.0', published_at: '2026-11-26T00:00:00Z', notes: '测试用发行。' },
      },
      characters: [{ id: 'traveler', name: '旅人', player_selectable: true }],
      openings: [{ id: 'arrival', name: '抵达', content: '你推开旅店的门。' }],
      state: { schema_version: 2, scopes: { message: {
        coins: { type: 'number', initial: 10, min: 0, description: '银钱' },
      } } },
    },
  };
  const save = (value: unknown = card) => writeFile(join(directory, 'world.json'), JSON.stringify(value));
  await save();
  return { temporary, directory, card, save };
}
function run(args: string[], temporary: string) {
  const result = spawnSync(process.execPath, ['--import', loader, script, ...args], {
    cwd: temporary, encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1', SERVER_DATA_ROOT: join(temporary, 'app-data') },
  });
  assert.equal(result.error, undefined);
  const output = result.status === 0 ? result.stdout : result.stderr;
  return { ...result, report: JSON.parse(output) };
}
async function exists(path: string) {
  try { await access(path); return true; }
  catch { return false; }
}

test('checks JSON from an unrelated cwd and never creates a data directory', async t => {
  const f = await fixture(t);
  const result = run(['check', relative(root, join(f.directory, 'world.json'))], f.temporary);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.format, 'json');
  assert.equal(result.report.name, '测试旅店');
  assert.equal(await exists(join(f.temporary, 'app-data')), false);
  assert.deepEqual((await inspectWorldSource(f.directory)).packageFiles, ['world.json']);
});

test('packs only allowed roots, checks the finished ZIP, and preserves source bytes', async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'README.md'), 'These notes must stay outside the ZIP.');
  await mkdir(join(f.directory, 'notes'));
  await writeFile(join(f.directory, 'notes', 'private.txt'), 'not an asset');
  await mkdir(join(f.directory, 'assets'));
  await writeFile(join(f.directory, 'assets', 'cover.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await f.save({ ...f.card, data: { ...f.card.data, cover: 'sr-asset://assets/cover.svg' } });
  const before = await readFile(join(f.directory, 'world.json'), 'utf8');
  const output = join(f.temporary, 'dist', 'demo.zip');
  const packed = run(['pack', f.directory, '--out', output], f.temporary);
  assert.equal(packed.status, 0, packed.stderr);
  assert.ok(packed.report.checks.includes('zip-import'));
  assert.deepEqual(packed.report.ignoredRootEntries, ['README.md', 'notes']);
  const checked = run(['check', output], f.temporary);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(checked.report.files, 2);
  const content = await inspectWorldSource(output);
  assert.deepEqual(content.packageFiles, ['assets/cover.svg', 'world.json']);
  assert.equal(await readFile(join(f.directory, 'world.json'), 'utf8'), before);
  assert.equal(await exists(join(f.temporary, 'app-data')), false);
});

test('packs current presentation fields, character content and display replacements without rewriting them', async t => {
  const f = await fixture(t);
  await mkdir(join(f.directory, 'assets'));
  await writeFile(join(f.directory, 'assets', 'inn.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const card = { ...f.card, data: { ...f.card.data,
    presentation: { type: 'markdown', text: '![旅店](sr-asset://assets/inn.svg)' },
    characters: [{ ...f.card.data.characters[0], content: '{{user}}正在寻找失落的信件。',
      presentation: { type: 'component', component: 'CharacterIntro' } }],
    openings: [{ ...f.card.data.openings[0],
      presentation: { type: 'markdown', text: '一个适合初次探索的起点。' } }],
    components: [{ id: 'CharacterIntro', component: 'export default function CharacterIntro(){return null;}' }],
    message_render: { rules: [{ id: 'inn', roles: ['assistant'], pattern: '旅店',
      replacement: { type: 'markdown', text: '![旅店](sr-asset://assets/inn.svg)' } }] },
  } };
  await f.save(card);
  const source = await readFile(join(f.directory, 'world.json'));
  const output = join(f.temporary, 'current.zip');
  const result = run(['pack', f.directory, '--out', output], f.temporary);
  assert.equal(result.status, 0, result.stderr);
  const packed = await inspectWorldSource(output);
  assert.deepEqual(packed.card, card);
  assert.deepEqual(packed.packageFiles, ['assets/inn.svg', 'world.json']);
  assert.deepEqual(await readFile(join(f.directory, 'world.json')), source);
  assert.equal(await exists(join(f.temporary, 'app-data')), false);
});

test('rejects retired author fields instead of silently dropping model content', async t => {
  const f = await fixture(t);
  await f.save({ ...f.card, data: { ...f.card.data,
    characters: [{ ...f.card.data.characters[0], prompt: '不得静默丢失的角色设定。' }],
  } });
  const result = run(['check', f.directory], f.temporary);
  assert.equal(result.status, 1);
  assert.equal(result.report.code, 'INVALID_WORLD_CARD');
  assert.match(result.report.message, /characters.*prompt/);
});

test('default ZIP is beside the directory and an existing output is never replaced', async t => {
  const f = await fixture(t);
  const first = run(['pack', f.directory], f.temporary);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.report.output, f.directory + '.zip');
  const before = await readFile(f.directory + '.zip');
  const second = run(['pack', f.directory], f.temporary);
  assert.equal(second.status, 1);
  assert.equal(second.report.code, 'OUTPUT_EXISTS');
  assert.deepEqual(await readFile(f.directory + '.zip'), before);
});

test('rejects invalid state and missing component references with exact locations', async t => {
  const f = await fixture(t);
  await f.save({ ...f.card, data: { ...f.card.data, openings: [
    { ...f.card.data.openings[0], initial_state: { coins: -1 } },
  ] } });
  const state = run(['check', f.directory], f.temporary);
  assert.equal(state.status, 1);
  assert.match(state.report.message, /initial_state.coins/);
  await f.save({ ...f.card, data: { ...f.card.data, stage_component: 'Missing' } });
  const component = run(['check', f.directory], f.temporary);
  assert.equal(component.status, 1);
  assert.match(component.report.message, /stage_component/);
});

test('rejects missing package assets and package URIs in a standalone JSON', async t => {
  const f = await fixture(t);
  await f.save({ ...f.card, data: { ...f.card.data, cover: 'sr-asset://assets/missing.svg' } });
  const directory = run(['check', f.directory], f.temporary);
  assert.equal(directory.status, 1);
  assert.match(directory.report.message, /missing.svg/);
  const json = run(['check', join(f.directory, 'world.json')], f.temporary);
  assert.equal(json.status, 1);
  assert.match(json.report.message, /JSON.*ZIP/);
});

test('component checks reject syntax, unsupported imports and cycles before publishing', async t => {
  const f = await fixture(t);
  const invalid = [
    [{ id: 'Stage', component: 'export default function Stage(){ return <div>; }' }],
    [{ id: 'Stage', component: "import ui from 'unavailable-library'; export default function Stage(){ return null; }" }],
    [
      { id: 'Stage', component: "import Child from './Child'; export default function Stage(){ return null; }" },
      { id: 'Child', component: "import Stage from './Stage'; export default function Child(){ return null; }" },
    ],
  ];
  for (const components of invalid) {
    await f.save({ ...f.card, data: { ...f.card.data, components, stage_component: 'Stage' } });
    const result = run(['pack', f.directory], f.temporary);
    assert.equal(result.status, 1);
    assert.equal(result.report.code, 'INVALID_WORLD_COMPONENT');
    assert.equal(await exists(f.directory + '.zip'), false);
  }
});

test('checks declared TSX files without executing them', async t => {
  const f = await fixture(t);
  await mkdir(join(f.directory, 'components'));
  await writeFile(join(f.directory, 'components', 'Stage.tsx'),
    "throw new Error('CHECKER_MUST_NOT_EXECUTE_AUTHOR_CODE'); export default function Stage(){ return null; }");
  await f.save({ ...f.card, data: { ...f.card.data,
    components: [{ id: 'Stage', path: 'sr-asset://components/Stage.tsx' }], stage_component: 'Stage',
  } });
  const result = run(['pack', f.directory], f.temporary);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.components, 1);
  assert.ok(result.report.limitations.some((line: string) => line.includes('未执行')));
});

test('rejects symlinks inside package roots', async t => {
  const f = await fixture(t);
  const outside = join(f.temporary, 'outside.txt');
  await writeFile(outside, 'must not be included');
  await mkdir(join(f.directory, 'assets'));
  await symlink(outside, join(f.directory, 'assets', 'leak.txt'));
  const result = run(['pack', f.directory], f.temporary);
  assert.equal(result.status, 1);
  assert.equal(result.report.code, 'INVALID_WORLD_PACKAGE_FILE');
  assert.equal(await exists(f.directory + '.zip'), false);
});

test('rejects an oversized undeclared component file', async t => {
  const f = await fixture(t);
  await mkdir(join(f.directory, 'components'));
  await writeFile(join(f.directory, 'components', 'Unused.tsx'), 'x'.repeat(1024 * 1024 + 1));
  const result = run(['check', f.directory], f.temporary);
  assert.equal(result.status, 1);
  assert.match(result.report.message, /Unused.tsx/);
});

test('uses the real importer to reject forbidden files in an incoming ZIP', async t => {
  const f = await fixture(t);
  const output = join(f.temporary, 'bad.zip');
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(f.card)), 'world.json');
  zip.addBuffer(Buffer.from('not allowed'), 'README.md');
  const writing = pipeline(zip.outputStream, createWriteStream(output));
  zip.end();
  await writing;
  const result = run(['check', output], f.temporary);
  assert.equal(result.status, 1);
  assert.equal(result.report.code, 'INVALID_WORLD_PACKAGE');
  assert.match(result.report.message, /只允许/);
});

test('requires a directory for pack and forbids output under packaged roots', async t => {
  const f = await fixture(t);
  const json = run(['pack', join(f.directory, 'world.json')], f.temporary);
  assert.equal(json.status, 1);
  assert.equal(json.report.code, 'INVALID_WORLD_DIRECTORY');
  const nested = run(['pack', f.directory, '--out', join(f.directory, 'assets', 'world.zip')], f.temporary);
  assert.equal(nested.status, 1);
  assert.equal(nested.report.code, 'INVALID_OUTPUT');
  const options = run(['check', f.directory, '--out', join(f.temporary, 'unused.zip')], f.temporary);
  assert.equal(options.status, 1);
  assert.equal(options.report.code, 'INVALID_ARGUMENT');
});

test('rejects output directory aliases into packaged roots before creating files', async t => {
  const f = await fixture(t);
  const assets = join(f.directory, 'assets');
  const alias = join(f.temporary, 'output-assets');
  await mkdir(assets);
  await symlink(assets, alias, 'dir');
  for (const suffix of ['release.zip', join('new-directory', 'release.zip')]) {
    const output = join(alias, suffix);
    const result = run(['pack', f.directory, '--out', output], f.temporary);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.report.code, 'INVALID_OUTPUT');
    assert.equal(await exists(join(assets, suffix)), false);
  }
  assert.equal(await exists(join(assets, 'new-directory')), false);
});
