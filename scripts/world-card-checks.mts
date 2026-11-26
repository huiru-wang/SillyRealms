import { realpath } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import type { WorldSourceInspection } from '../apps/server/src/modules/worlds/service.js';
// This pure compiler entry never loads browser WASM or executes author components.
import { inspectModule, moduleGraph } from '../packages/sr-ui-compiler/src/modules.js';

export class WorldCardToolError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function checkWorldComponents(inspection: WorldSourceInspection): void {
  const ids = new Set(inspection.components.map(component => component.id));
  for (const source of inspection.components) {
    try { inspectModule(source.component, ids); }
    catch (error) {
      throw new WorldCardToolError('INVALID_WORLD_COMPONENT', source.id + ': ' + (error instanceof Error ? error.message : String(error)));
    }
  }
  try { moduleGraph(inspection.components); }
  catch (error) { throw new WorldCardToolError('INVALID_WORLD_COMPONENT', error instanceof Error ? error.message : String(error)); }
}

// Resolve the nearest existing parent so directory aliases cannot write into package roots.
export async function resolvedOutputPath(output: string): Promise<string> {
  let directory = dirname(output);
  const suffix = [basename(output)];
  while (true) {
    try { return resolve(await realpath(directory), ...suffix); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      const parent = dirname(directory);
      if (parent === directory) throw error;
      suffix.unshift(basename(directory));
      directory = parent;
    }
  }
}

export async function assertOutsidePackage(source: string, output: string): Promise<void> {
  const inside = relative(await realpath(source), await resolvedOutputPath(output));
  if (inside === 'world.json' || ['assets', 'components'].some(root => inside === root || inside.startsWith(root + sep))) {
    throw new WorldCardToolError('INVALID_OUTPUT', '输出不能覆盖 world.json 或放在源码的 assets/、components/ 中');
  }
}
