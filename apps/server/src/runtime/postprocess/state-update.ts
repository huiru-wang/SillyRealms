import { isDeepStrictEqual } from 'node:util';
import { ErrorCodes } from '../../common/error-codes.js';
import { applyRuntimeStateUpdate } from '../../domain/state/runtime-update.js';
import type { Json } from '../../domain/state/state.js';
import type { ParsedBlock } from './parser.js';
import type { StateUpdateResult } from './contracts.js';

export function handleStateUpdate(block: ParsedBlock | undefined, initial: StateUpdateResult, baseline: Record<string, Json>,
  modules: Record<string, any>, active: ReadonlySet<string>): {
    workspace: Record<string, Json>; result: StateUpdateResult;
  } {
  const result = structuredClone(initial), workspace = structuredClone(baseline);
  if (result.status !== 'pending') return { workspace, result };
  if (!block || block.error || !Array.isArray(block.value) || block.value.length > 100) {
    result.status = 'failed'; result.errorCode = !block ? ErrorCodes.STATE_UPDATE_MISSING : ErrorCodes.STATE_UPDATE_INVALID;
    return { workspace, result };
  }
  let skipped = false;
  for (const raw of block.value) {
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.path !== 'string' ||
          !Object.hasOwn(raw, 'value') || Object.keys(raw).some(key => !['path', 'value', 'reason'].includes(key)))
        throw new Error(ErrorCodes.INVALID_STATE_UPDATE);
      applyRuntimeStateUpdate(workspace, modules, active, raw.path, raw.value);
    } catch { skipped = true; }
  }
  result.status = skipped ? 'partial' : isDeepStrictEqual(baseline, workspace) ? 'unchanged' : 'applied';
  return { workspace, result };
}
