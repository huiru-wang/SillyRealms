/**
 * Validate a world ZIP without publishing it or touching an application database.
 *
 * From the repository root:
 * pnpm --dir apps/server exec tsx ../../world/worldcards/庄园/validate.ts
 *
 * An optional first argument selects another ZIP. All extraction is confined to a
 * newly-created system temporary directory and is removed before success returns.
 */
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm, stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {
  WorldFileStore, WORLD_ZIP_LIMIT, resolvePackagePath, type ImportFileStage,
} from '../../../apps/server/src/modules/worlds/files.ts';
import {readImportPackage} from '../../../apps/server/src/modules/worlds/archive.ts';
import {readComponents} from '../../../apps/server/src/modules/worlds/assets.ts';
import {parseCard} from '../../../apps/server/src/modules/worlds/parser.ts';
import {parseSRAssetUri} from '../../../packages/sr-sdk/src/asset-url.ts';
import {moduleGraph} from '../../../packages/sr-ui-compiler/src/modules.ts';

const here = dirname(resolve(process.argv[1]!));
const serverRequire = createRequire(join(here, '../../../apps/server/package.json'));
const esbuild = createRequire(serverRequire.resolve('tsx'))('esbuild') as {
  transform(source: string, options: Record<string, unknown>): Promise<unknown>;
};

async function packageFiles(root: string, relative = ''): Promise<Array<{path: string; bytes: number}>> {
  const files: Array<{path: string; bytes: number}> = [];
  for (const entry of await readdir(join(root, relative), {withFileTypes: true})) {
    const path = relative ? relative + '/' + entry.name : entry.name;
    if (entry.isDirectory()) files.push(...await packageFiles(root, path));
    else if (entry.isFile()) files.push({path, bytes: (await stat(join(root, path))).size});
    else throw new Error('Unexpected non-regular package entry: ' + path);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function inspectStrings(value: unknown, visit: (text: string) => void): void {
  if (typeof value === 'string') visit(value);
  else if (Array.isArray(value)) value.forEach(item => inspectStrings(item, visit));
  else if (value && typeof value === 'object') {
    Object.values(value).forEach(item => inspectStrings(item, visit));
  }
}

async function validate(path: string) {
  const zipStat = await stat(path);
  if (!zipStat.isFile() || zipStat.size === 0 || zipStat.size > WORLD_ZIP_LIMIT) {
    throw new Error('ZIP must be a nonempty regular file of at most 256 MiB');
  }
  const bytes = await readFile(path);
  const zipSha256 = createHash('sha256').update(bytes).digest('hex');
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'sr-manor-validate-'));
  const files = new WorldFileStore(temporaryRoot);
  let stage: ImportFileStage | undefined;
  try {
    stage = await files.stageImport('manor-validation', 'zip', bytes);
    const imported = await readImportPackage(stage);
    const card = parseCard(imported);
    const packageRoot = join(stage.root, 'package');
    const manifestFile = await resolvePackagePath(packageRoot, 'world.json');
    const manifestText = await readFile(manifestFile.path, 'utf8');
    const manifest = JSON.parse(manifestText) as unknown;
    const components = await readComponents(
      card.data.components ?? [],
      relative => resolvePackagePath(packageRoot, relative),
    );
    const componentErrors = Object.keys(components.errors);
    if (componentErrors.length) {
      throw new Error('Component resources could not be read: ' + componentErrors.join(', '));
    }
    const graph = moduleGraph(components.items);
    for (const item of components.items) {
      await esbuild.transform(item.component, {
        loader: 'tsx', format: 'cjs', jsx: 'transform', target: 'es2022',
      });
    }

    const references = new Set<string>();
    const remoteUrls = new Set<string>();
    let localReferenceOccurrences = 0;
    const collect = (text: string) => {
      // The generated package uses deterministic filename-safe image paths.
      // Inspect both author JSON strings and external component source strings.
      const local = /sr-asset:\/\/[^\s"'\x60<>(){}\\]+/gi;
      const remote = /https?:\/\/[^\s"'\x60<>(){}\\]+/gi;
      for (const match of text.matchAll(local)) {
        const relative = parseSRAssetUri(match[0]);
        references.add(relative);
        localReferenceOccurrences++;
      }
      for (const match of text.matchAll(remote)) remoteUrls.add(match[0]);
    };
    inspectStrings(manifest, collect);
    for (const item of components.items) collect(item.component);
    for (const relative of references) await resolvePackagePath(packageRoot, relative);

    const inventory = await packageFiles(packageRoot);
    const assets = inventory.filter(item => item.path.startsWith('assets/'));
    const componentFiles = inventory.filter(item => item.path.startsWith('components/'));
    return {
      status: 'pass',
      zip: resolve(path),
      zipBytes: bytes.byteLength,
      zipSha256,
      packageBytes: inventory.reduce((total, item) => total + item.bytes, 0),
      fileCount: inventory.length,
      characterCount: card.data.characters.length,
      openingCount: card.data.openings.length,
      componentCount: graph.size,
      componentFileCount: componentFiles.length,
      assetCount: assets.length,
      assetBytes: assets.reduce((total, item) => total + item.bytes, 0),
      stateSchemaVersion: card.data.state?.schema_version ?? null,
      localReferenceOccurrences,
      uniqueLocalReferences: references.size,
      unreferencedAssetCount: assets.filter(item => !references.has(item.path)).length,
      remainingHttpUrlCount: remoteUrls.size,
      checks: {
        importSizeAndArchive: 'pass',
        cardAndStateParser: 'pass',
        declaredComponentResources: 'pass',
        moduleGraph: 'pass',
        tsxCompilation: 'pass',
        allLocalResourceReferences: 'pass',
        temporaryWorkspaceCleanup: 'pass',
      },
    };
  } finally {
    try {
      if (stage) await files.discardImport(stage);
    } finally {
      await rm(temporaryRoot, {recursive: true, force: true});
    }
  }
}

async function main() {
  const input = process.argv[2] ? resolve(process.argv[2]) : join(here, 'manor-world.zip');
  try {
    const summary = await validate(input);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    const detail = error as {code?: string; message?: string};
    console.error(JSON.stringify({
      status: 'failed',
      errorCode: detail.code ?? 'VALIDATION_FAILED',
      message: detail.message ?? 'Unknown validation failure',
    }, null, 2));
    process.exitCode = 1;
  }
}
void main();
