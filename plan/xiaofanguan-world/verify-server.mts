/**
 * Real ZIP/API verification, isolated from the user's data and credentials.
 * Run at the repository root:
 *   pnpm --filter @sillyrealms/server exec tsx ../../plan/xiaofanguan-world/verify-server.mts
 * Add --serve [--manifest /temporary/path.json] to keep Host + Stage open for browser QA.
 * All runtime files and the connection manifest live in a fresh OS temporary directory.
 */
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import type {Server} from 'node:http';
import {openDatabase} from '../../apps/server/src/infrastructure/database/database.ts';
import {createApp} from '../../apps/server/src/app.ts';
import {WorldFileStore} from '../../apps/server/src/infrastructure/world-files/world-file-store.ts';
import {createStageApp, serveWebConfig} from '../../apps/server/src/infrastructure/http/stage-assets.ts';
import {serveStudio} from '../../apps/server/src/infrastructure/http/studio-assets.ts';
import {parseCard} from '../../apps/server/src/domain/world-card.ts';
import {defaultPreset} from '../../apps/server/src/domain/preset/schema.ts';
import {updatePreset} from '../../apps/server/src/repositories/preset-repository.ts';
import {seedModel, fakeCredentials} from '../../apps/server/test/fixtures/db-seed.ts';
import {testModel, response, tail} from '../../apps/server/test/fixtures/runtime-v2.ts';
import {moduleGraph} from '../../packages/sr-ui-compiler/src/modules.ts';
import type {ModelGateway} from '../../apps/server/src/runtime/model/pi-gateway.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
let keepServing = false;
let connectionManifest: string | undefined;
const arguments_ = process.argv.slice(2);
while (arguments_.length) {
  const argument = arguments_.shift();
  if (argument === '--serve') keepServing = true;
  else if (argument === '--manifest') {
    const value = arguments_.shift();
    assert(value && !value.startsWith('--'), '--manifest requires a temporary output filename');
    connectionManifest = resolve(value);
  } else throw Error('Unknown argument: ' + argument);
}
assert(!connectionManifest || keepServing, '--manifest requires --serve');
const require = createRequire(join(root, 'apps/server/package.json'));
const {serve} = require('@hono/node-server');
const yauzl = require('yauzl');
const {transform} = createRequire(require.resolve('tsx'))('esbuild');
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const zipPath = join(here, '../xiaofanguan-world.zip');
const original = JSON.parse(readFileSync(join(here, 'source/character-card.json'), 'utf8')).data;
const provenance = JSON.parse(readFileSync(join(here, 'source/provenance.json'), 'utf8'));
const normalizeUser = (value: string) => value.replace(/\{\{user\}\}|<user>|\buser\b/g, '{{user}}');
const material = (value: string) => value.replaceAll('{{user}}', '掌柜').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const narrative = '灶上的豆腐咕嘟作响。李鱼儿合上账本，轻声问：“掌柜，今日的青菜照旧做清炒吗？”李鸟儿端来两只干净碗，笑着催了一句：“等菜上齐，咱们也该吃饭啦。”';
const suggestions = ['问问姐妹今日想吃什么', '去灶边看看豆腐的火候', '招呼新来的食客点菜'];
const rawResponse = narrative + tail([], suggestions);
const sourceEntries = original.character_book.entries as Array<Record<string, any>>;
const npcSource = sourceEntries.find(entry => entry.id === 3)!.content as string;
const npcBody = /^<character>\r?\n([\s\S]*)<\/character>\r?\n?$/.exec(npcSource)?.[1];
assert(npcBody, 'Original NPC source wrapper is missing');
const splitAt = npcBody.indexOf('完整角色卡_李鸟儿:');
assert(splitAt > 0, 'Original NPC source split marker is missing');
const expectedPrompts = [npcBody.slice(0, splitAt), npcBody.slice(splitAt)].map(block => '<character>\n' + normalizeUser(block) + '</character>\n');
const expectedOpenings = [original.first_mes, ...original.alternate_greetings] as string[];
const expectedOpeningIds = ['daily-opening', 'opening-keeper', 'opening-boss'];

function count(text: string, part: string) {
  assert(part.length > 0);
  return text.split(part).length - 1;
}

async function readArchive(bytes: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolveArchive, reject) => {
    yauzl.fromBuffer(bytes, {lazyEntries: true}, (error: Error | null, zip: any) => {
      if (error) return reject(error);
      const files = new Map<string, Buffer>();
      zip.on('error', reject);
      zip.on('end', () => resolveArchive(files));
      zip.on('entry', (entry: any) => {
        if (entry.fileName.endsWith('/')) return zip.readEntry();
        if (files.has(entry.fileName)) return reject(Error('Duplicate ZIP entry: ' + entry.fileName));
        zip.openReadStream(entry, (streamError: Error | null, stream: any) => {
          if (streamError) return reject(streamError);
          const chunks: Buffer[] = [];
          stream.on('error', reject);
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => {
            files.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

const archive = readFileSync(zipPath);
const archiveFiles = await readArchive(archive);
assert.deepEqual([...archiveFiles.keys()].sort(), [
  'assets/images/keeper.jpg',
  'assets/images/li-niaoer.jpg',
  'assets/images/li-yuer.jpg',
  'components/WorldIntroduction.tsx',
  'world.json',
]);
for (const [name, bytes] of archiveFiles) {
  assert.deepEqual(bytes, readFileSync(join(here, 'package', name)), 'ZIP differs from committed package source: ' + name);
}
const card = parseCard(JSON.parse(archiveFiles.get('world.json')!.toString('utf8')));
assert.equal(card.data.name, original.name);
assert.equal(card.data.state, undefined, 'No state system exists in the original card');
assert.equal(card.data.stage_component, undefined, 'The card should use the official WorldStory');
assert.deepEqual(card.data.characters.map(character => [character.id, character.name, character.player_selectable]), [
  ['user', '掌柜', true], ['li-yuer', '李鱼儿', false], ['li-niaoer', '李鸟儿', false],
]);
assert(card.data.characters.every(character => character.load?.mode === 'always'));
assert.deepEqual(card.data.openings.map(opening => opening.id), expectedOpeningIds);
assert.deepEqual(card.data.openings.map(opening => opening.content), expectedOpenings, 'All three openings must remain verbatim');
const npcs = ['li-yuer', 'li-niaoer'].map(id => card.data.characters.find(character => character.id === id)!);
assert.deepEqual(npcs.map(npc => npc.prompt), expectedPrompts, 'The full NPC source must survive the split, including whitespace');
const lore = card.data.lorebook!.entries;
assert.deepEqual(lore.map(entry => entry.id), [0, 1, 2, 4].map(id => 'source-lore-' + id));
for (const entry of lore) {
  const source = sourceEntries.find(source => 'source-lore-' + source.id === entry.id)!;
  assert.equal(entry.content, normalizeUser(source.content), 'Only the player macro may change in source lore ' + entry.id);
  assert.equal(entry.enabled, true);
  assert.equal(entry.load?.mode, 'always');
  assert.equal(entry.load?.order, source.insertion_order);
}
assert(!lore.some(entry => entry.content.includes('完整角色卡_')), 'NPC source must not be duplicated in lore');
assert.deepEqual(card.data.components!.map(component => component.id), ['WorldIntroduction']);
assert(card.data.components!.every(component => component.path && !component.component));
for (const asset of provenance.assets) {
  assert.equal(sha256(archiveFiles.get(asset.target)!), asset.sha256, 'Source image changed: ' + asset.target);
}
assert.equal(sha256(readFileSync(join(here, 'source/character-card.json'))), provenance.sourceCard.metadataSha256);

const temporary = mkdtempSync(join(tmpdir(), 'sr-xiaofanguan-verify-'));
const manifestPath = connectionManifest ?? join(temporary, 'manifest.json');
const reportPath = join(temporary, 'verification-report.json');
const db = openDatabase(':memory:');
const files = new WorldFileStore(temporary);
const contextChecks: Record<string, any>[] = [];
const report: Record<string, any> = {
  success: false,
  archive: {path: zipPath, bytes: archive.length, sha256: sha256(archive), entries: [...archiveFiles.keys()]},
  isolation: {database: ':memory:', temporary, credentials: 'fake fixture', provider: 'fake gateway, zero network calls'},
  source: {pngSha256: provenance.sourceCard.sha256, metadataSha256: provenance.sourceCard.metadataSha256},
  content: {characters: 3, selectable: ['user'], verbatimOpenings: 3, sourceLoreEntries: 5, loreEntries: 4, completeNpcPrompts: 2},
  checks: [],
  contextChecks,
};
const manifest: Record<string, any> = {
  pid: process.pid, manifestPath, reportPath, temporary, zipPath, narrative, suggestions,
  worldId: null, reimportedWorldId: null, sessionIds: {}, report,
};

function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => part?.type === 'text').map(part => part.text).join('');
}

function checkContext(context: any) {
  const messages = context.messages ?? [];
  const systemText = [context.systemPrompt ?? '', ...messages.filter((message: any) => message.role === 'system').map((message: any) => textContent(message.content))].join('\n\n');
  const allText = [context.systemPrompt ?? '', ...messages.map((message: any) => textContent(message.content))].join('\n\n');
  assert(!context.tools?.length, 'Direct story request must not register tools');
  const expected = [
    ...card.data.characters.map(character => ({id: character.id, text: material(character.prompt ?? '')})),
    ...lore.map(entry => ({id: entry.id, text: material(entry.content)})),
  ];
  for (const item of expected) {
    assert.equal(count(allText, item.text), 1, 'Expected one complete model material: ' + item.id);
  }
  assert(!systemText.includes('{{user}}'), 'Player macro was left in model system materials');
  assert(!systemText.includes('<user>'), 'Source player marker was left in model system materials');
  assert(!systemText.includes('data:image/'), 'Images must not enter model prompts');
  assert(!allText.includes('export default function WorldIntroduction'), 'UI source must not enter model prompts');
  assert(!systemText.includes('sr-asset://'), 'Asset URI must not enter model prompts');
  assert(allText.includes('被掌柜买回来的孩子'), 'Player macro must become the selected player name');
  assert(allText.indexOf('完整角色卡_李鱼儿:') < allText.indexOf('完整角色卡_李鸟儿:'), 'NPC order changed');
  const loreOffsets = lore.map(entry => allText.indexOf(material(entry.content)));
  assert(loreOffsets.every((offset, index) => index === 0 || offset > loreOffsets[index - 1]), 'Lore order changed');
  const item = {
    call: contextChecks.length + 1,
    characters: 3, loreEntries: 4, completeNpcPrompts: 2,
    completeMaterialsOnce: true, playerResolvedTo: '掌柜', noAssetOrComponentPayload: true,
    contextCharacters: allText.length, contextSha256: sha256(JSON.stringify(context)),
  };
  contextChecks.push(item);
  writeFileSync(join(temporary, 'context-' + item.call + '.json'), json(context));
  return item;
}

const gateway: ModelGateway = {
  resolve: () => ({...testModel, name: '小饭馆隔离验收 · 离线假模型', contextWindow: 131072, maxTokens: 8192}),
  supportsDirect: () => true,
  usageReported: () => true,
  stream: (_model, context, {signal}) => ({
    async *[Symbol.asyncIterator]() {
      checkContext(context);
      for (const delta of [narrative, tail([], suggestions)]) {
        if (signal.aborted) return;
        if (keepServing) await delay(80);
        yield {type: 'text_delta', delta, contentIndex: 0, partial: {} as never} as any;
      }
      if (!signal.aborted) yield {type: 'done', reason: 'stop', message: response(rawResponse)} as any;
    },
  }),
};
seedModel(db);
const preset = defaultPreset();
preset.context_strategy.max_context_tokens = 65536;
preset.context_strategy.max_output_tokens = 2048;
for (const id of ['worldState', 'actionSuggestions']) {
  assert(preset.config_json.nodes.some(node => node.id === id && node.enabled), 'Required fake response extension is disabled: ' + id);
}
updatePreset(db, 'sr-default-preset', preset);
db.prepare('UPDATE app_settings SET default_preset_id=?,default_api_model_config_id=? WHERE id=1').run('sr-default-preset', 'test-model');
const stageOrigins = new Set<string>();
const app = createApp(db, fakeCredentials, gateway, files, new Set(), stageOrigins);
const studioDirectory = join(root, 'apps/studio/dist');
const stageApp = createStageApp(studioDirectory, files, id => !!db.prepare('SELECT 1 FROM worlds WHERE id=?').get(id));
let hostServer: Server | undefined;
let stageServer: Server | undefined;
let cleanupPromise: Promise<void> | undefined;
const persist = () => {
  writeFileSync(reportPath, json(report));
  if (!keepServing || manifest.origin) writeFileSync(manifestPath, json(manifest));
};
async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    await app.shutdown();
    await Promise.all([hostServer, stageServer].filter(Boolean).map(server => new Promise<void>(resolveClose => {
      server!.close(() => resolveClose());
      server!.closeAllConnections?.();
    })));
    db.close();
    rmSync(temporary, {recursive: true, force: true});
    if (connectionManifest) rmSync(connectionManifest, {force: true});
  })();
  return cleanupPromise;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void cleanup().then(() => process.exit(0), error => { console.error(error); process.exit(1); }); });
}

async function api(path: string, init?: RequestInit, status = 200): Promise<any> {
  const result = await app.request(path, init);
  const body = await result.json() as any;
  assert.equal(result.status, status, path + ': ' + JSON.stringify(body));
  assert.equal(body.success, true, path + ': ' + JSON.stringify(body));
  return body.data;
}
const post = (value: unknown): RequestInit => ({method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(value)});
async function importArchive(bytes: Buffer, filename: string) {
  const body = new FormData();
  body.set('file', new File([new Uint8Array(bytes)], filename, {type: 'application/zip'}));
  return (await api('/api/v1/worlds/import', {method: 'POST', body}, 201)).item;
}
function normalizedData(data: any) {
  const parsed = parseCard({spec: 'world_card', spec_version: '0.1', data}).data;
  return {...parsed, tags: [...(parsed.tags ?? [])].sort()};
}
async function componentsFor(worldId: string) {
  const resolved = await api('/api/v1/worlds/' + worldId + '/components');
  assert.deepEqual(resolved.errors, {}, 'Path components failed to resolve');
  assert.equal(resolved.items.length, card.data.components!.length);
  const graph = moduleGraph(resolved.items);
  const compiled = [];
  for (const source of resolved.items) {
    const definition = card.data.components!.find(component => component.id === source.id)!;
    assert.equal(source.component, archiveFiles.get(definition.path!.slice('sr-asset://'.length))!.toString('utf8'));
    const result = await transform(source.component, {loader: 'tsx', format: 'cjs', jsx: 'transform', target: 'es2022'});
    assert(result.code.includes('exports'), 'Component compilation did not produce a module');
    compiled.push({id: source.id, bytes: Buffer.byteLength(source.component), compiledBytes: Buffer.byteLength(result.code)});
  }
  return {compiled, dependencies: Object.fromEntries(graph)};
}
async function assetsFor(worldId: string) {
  const results = [];
  for (const asset of provenance.assets) {
    const path = '/world-assets/' + worldId + '/' + asset.target;
    const result = await stageApp.request(path);
    assert.equal(result.status, 200, 'Asset unavailable: ' + path);
    assert.equal(result.headers.get('content-type'), 'image/jpeg');
    assert.equal(result.headers.get('cache-control'), 'private, no-cache', 'Package assets should support private cache revalidation');
    const etag = result.headers.get('etag');
    assert(etag, 'Asset ETag missing');
    assert.equal(sha256(new Uint8Array(await result.arrayBuffer())), asset.sha256);
    const cached = await stageApp.request(path, {headers: {'if-none-match': etag}});
    assert.equal(cached.status, 304);
    const head = await stageApp.request(path, {method: 'HEAD'});
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(asset.bytes));
    results.push({path: asset.target, bytes: asset.bytes, sha256: asset.sha256, contentType: result.headers.get('content-type'), cache: result.headers.get('cache-control'), conditionalGet: 304});
  }
  return results;
}

try {
  // Hono freezes its route matcher on the first request: register browser routes first.
  if (keepServing) {
    assert(existsSync(join(studioDirectory, 'index.html')) && existsSync(join(studioDirectory, 'frame.html')), 'Build Studio before --serve: pnpm build');
    stageServer = serve({fetch: stageApp.fetch, hostname: '127.0.0.1', port: 0});
    if (!stageServer!.listening) await once(stageServer!, 'listening');
    manifest.stagePort = (stageServer!.address() as any).port;
    manifest.stageOrigin = 'http://127.0.0.1:' + manifest.stagePort;
    stageOrigins.add(manifest.stageOrigin);
    serveWebConfig(app, {origin: null, port: manifest.stagePort, entryPath: '/frame.html'});
    app.get('/__xiaofanguan_verification__', c => { persist(); return c.json(manifest); });
    serveStudio(app, studioDirectory);
  }
  const imported = await importArchive(archive, 'xiaofanguan-world.zip');
  manifest.worldId = imported.id;
  assert.equal(imported.defaultPresetId, 'sr-default-preset');
  assert.equal(imported.defaultApiModelConfigId, 'test-model');
  assert.deepEqual(normalizedData(imported.data), normalizedData(card.data));
  report.checks.push({name: 'real-zip-import', passed: true, worldId: imported.id});
  const sources = await componentsFor(imported.id);
  report.checks.push({name: 'source-resolution-and-tsx-compilation', passed: true, ...sources});
  const assets = await assetsFor(imported.id);
  report.checks.push({name: 'offline-jpeg-assets-cache-and-head', passed: true, assets});

  for (const [index, opening] of card.data.openings.entries()) {
    const session = (await api('/api/v1/sessions', post({
      worldId: imported.id, openingId: opening.id, userCharacterId: 'user', title: '隔离验收 · ' + opening.name,
    }), 201)).item;
    manifest.sessionIds[opening.id] = session.id;
    const history = await api('/api/v1/sessions/' + session.id + '/history');
    const entries = history.runs.flatMap((run: any) => run.entries);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].role, 'assistant');
    assert.equal(entries[0].origin, 'opening');
    assert.equal(entries[0].text, expectedOpenings[index], 'Session initialization changed opening text');
    const state = await api('/api/v1/sessions/' + session.id + '/state');
    assert.deepEqual({global: state.global, session: state.session, message: state.message}, {global: {}, session: {}, message: {}});
    const started = await api('/api/v1/sessions/' + session.id + '/runs', post({
      text: '看看今日的青菜和豆腐，问问姐妹早饭吃了没有。',
      requestId: randomUUID(), expectedTipEntryId: session.tipEntryId,
    }), 202);
    let result: any;
    const deadline = Date.now() + 15000;
    do {
      result = await api('/api/v1/sessions/' + session.id + '/runs/' + started.runId);
      if (['completed', 'failed', 'stopped'].includes(result.status)) break;
      await delay(20);
    } while (Date.now() < deadline);
    assert.equal(result.status, 'completed', 'Fake run failed: ' + JSON.stringify(result));
    assert.equal(result.messages.find((message: any) => message.role === 'assistant')?.text, narrative);
    assert.equal(result.extensions?.actionSuggestions?.status, 'ready');
    assert(['unchanged', 'not_required'].includes(result.extensions?.stateUpdate?.status), 'Empty state update should not change state: ' + JSON.stringify(result.extensions));
    const after = await api('/api/v1/sessions/' + session.id + '/state');
    assert.deepEqual(after.message, {});
    report.checks.push({
      name: 'opening-and-fake-runtime', passed: true, openingId: opening.id, openingSha256: sha256(opening.content),
      sessionId: session.id, runId: started.runId, extensions: result.extensions,
    });
  }
  assert.equal(contextChecks.length, 3, 'Expected one direct model request for each opening');
  // Changing only the temporary DB proves export does not trust package/world.json.
  const databaseName = card.data.name + '（隔离导出校验）';
  db.prepare('UPDATE worlds SET name=? WHERE id=?').run(databaseName, imported.id);
  const editedExport = await app.request('/api/v1/worlds/' + imported.id + '/export');
  assert.equal(editedExport.status, 200);
  const editedFiles = await readArchive(Buffer.from(await editedExport.arrayBuffer()));
  assert.equal(JSON.parse(editedFiles.get('world.json')!.toString()).data.name, databaseName);
  assert.equal(JSON.parse(readFileSync((await files.resolvePackageFile(imported.id, 'world.json')).path, 'utf8')).data.name, card.data.name);
  db.prepare('UPDATE worlds SET name=? WHERE id=?').run(card.data.name, imported.id);
  report.checks.push({name: 'export-rebuilds-manifest-from-database', passed: true});

  const exported = await app.request('/api/v1/worlds/' + imported.id + '/export');
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get('content-type'), 'application/zip');
  const exportedBytes = Buffer.from(await exported.arrayBuffer());
  writeFileSync(join(temporary, 'roundtrip.zip'), exportedBytes);
  const exportedFiles = await readArchive(exportedBytes);
  assert.deepEqual([...exportedFiles.keys()].sort(), [...archiveFiles.keys()].sort());
  assert.deepEqual(normalizedData(JSON.parse(exportedFiles.get('world.json')!.toString()).data), normalizedData(card.data));
  for (const [name, bytes] of archiveFiles) {
    if (name !== 'world.json') assert.deepEqual(exportedFiles.get(name), bytes, 'Export changed package bytes: ' + name);
  }
  const reimported = await importArchive(exportedBytes, 'xiaofanguan-roundtrip.zip');
  manifest.reimportedWorldId = reimported.id;
  assert.notEqual(reimported.id, imported.id);
  assert.deepEqual(normalizedData(reimported.data), normalizedData(card.data));
  await componentsFor(reimported.id);
  await assetsFor(reimported.id);
  report.checks.push({name: 'real-zip-export-and-reimport', passed: true, reimportedWorldId: reimported.id, bytes: exportedBytes.length});
  report.success = true;
  report.completedAt = new Date().toISOString();
  // Persist only reproducible evidence: no local paths, ports, UUIDs or wall-clock timestamps.
  const stableReport = {
    success: true,
    artifact: {path: 'plan/xiaofanguan-world.zip', bytes: archive.length, sha256: sha256(archive)},
    isolation: {database: ':memory:', fakeCredentials: true, fakeGateway: true, paidProviderCalls: 0},
    source: report.source,
    content: report.content,
    checks: report.checks.map((check: any) => Object.fromEntries(Object.entries(check)
      .filter(([key]) => !['worldId', 'sessionId', 'runId', 'reimportedWorldId'].includes(key)))),
    contextChecks: contextChecks.map(check => Object.fromEntries(Object.entries(check)
      .filter(([key]) => key !== 'contextSha256'))),
  };
  mkdirSync(join(here, 'verification'), {recursive: true});
  writeFileSync(join(here, 'verification/server-report.json'), json(stableReport));
  persist();

  if (keepServing) {
    hostServer = serve({fetch: app.fetch, hostname: '127.0.0.1', port: 0});
    if (!hostServer!.listening) await once(hostServer!, 'listening');
    manifest.port = (hostServer!.address() as any).port;
    manifest.origin = 'http://127.0.0.1:' + manifest.port;
    manifest.worldUrl = manifest.origin + '/worlds/' + manifest.worldId;
    manifest.sessionUrls = Object.fromEntries(Object.entries(manifest.sessionIds).map(([id, value]) => [id, manifest.origin + '/sessions/' + value]));
    persist();
    console.log(json(manifest));
  } else {
    console.log(json(report));
    await cleanup();
  }
} catch (error) {
  report.success = false;
  report.error = error instanceof Error ? {message: error.message, stack: error.stack} : String(error);
  persist();
  console.error(json(report));
  await cleanup();
  process.exitCode = 1;
}
