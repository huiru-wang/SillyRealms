import { ErrorCodes } from '../../common/error-codes.js';
import { updateAtomicState, type AtomicStateDefinition } from './atomic-state.js';
import type { Json } from './state.js';

/** Shared domain permission boundary for tools and narrative candidates. */
export function applyRuntimeStateUpdate(workspace: Record<string, Json>, fields: Record<string, AtomicStateDefinition>,
  active: ReadonlySet<string>, path: string | string[], value: unknown): void {
  const parts = typeof path === 'string' ? path.split('.') : path;
  if (!parts.length || parts.some(part => typeof part !== 'string' || !part || part.includes('.')))
    throw new Error(ErrorCodes.INVALID_STATE_PATH);
  if (!active.has(parts[0]!)) throw new Error(ErrorCodes.STATE_ROOT_NOT_ACTIVE);
  updateAtomicState(workspace, fields, parts.join('.'), value);
}
