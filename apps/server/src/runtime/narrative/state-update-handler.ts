import { isDeepStrictEqual } from 'node:util';
import { ErrorCodes, normalizeError } from '../../common/error-codes.js';
import { applyRuntimeStateUpdate } from '../../domain/state/runtime-update.js';
import type { Json } from '../../domain/state/state.js';
import type { ParsedBlock } from './extension-parser.js';
import type { StateUpdateResult } from './extension-contract.js';

export function handleStateUpdate(block: ParsedBlock | undefined, initial: StateUpdateResult, baseline: Record<string, Json>,
  modules: Record<string, any>, active: ReadonlySet<string>): {
    workspace: Record<string, Json>; result: StateUpdateResult; diagnostics: Array<{ index: number; reason: string }>;
  } {
  const result = structuredClone(initial);
  const workspace = structuredClone(baseline);
  const diagnostics: Array<{ index: number; reason: string }> = [];
  if (result.status !== 'pending') {
    if (block) result.warningCodes.push('unexpected_disabled_block');
    return { workspace, result, diagnostics };
  }
  if (!block || block.error || !Array.isArray(block.value) || block.value.length > 100) {
    result.status = 'failed'; result.errorCode = !block ? ErrorCodes.STATE_UPDATE_MISSING : ErrorCodes.STATE_UPDATE_INVALID;
    return { workspace, result, diagnostics };
  }
  const accepted: string[] = [];
  for (const [index, raw] of block.value.entries()) {
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.path !== 'string' ||
          !Object.hasOwn(raw, 'value') || Object.keys(raw).some(key => !['path', 'value', 'reason'].includes(key)))
        throw new Error(ErrorCodes.INVALID_STATE_UPDATE);
      applyRuntimeStateUpdate(workspace, modules, active, raw.path, raw.value);
      result.acceptedCount++;
      accepted.push(raw.path);
      if (typeof raw.reason !== 'string' || !raw.reason.trim()) result.warningCodes.push('reason_missing');
      else {
        const chars = Array.from(raw.reason.trim());
        if (chars.length > 120) result.warningCodes.push('reason_truncated');
        diagnostics.push({ index, reason: chars.slice(0, 120).join('') });
      }
    } catch (error) { result.skipped.push({ index, ...normalizeError(error, ErrorCodes.INVALID_STATE_UPDATE) }); }
  }
  const get = (object: unknown, path: string): unknown => path.split('.').reduce<unknown>((value, key) =>
    value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, object);
  result.changedPaths = [...new Set(accepted)].filter(path => !isDeepStrictEqual(get(baseline, path), get(workspace, path)));
  result.warningCodes = [...new Set(result.warningCodes)];
  result.status = result.skipped.length ? 'partial' : result.changedPaths.length ? 'applied' : 'unchanged';
  return { workspace, result, diagnostics };
}
