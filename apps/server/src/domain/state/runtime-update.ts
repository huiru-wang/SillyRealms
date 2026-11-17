import { isSafeStateKey, StateValidationError } from '@sillyrealms/sdk/state-validation';
import { updateAtomicState, type AtomicStateDefinition } from './atomic-state.js';
import type { Json } from './state.js';

/** Shared domain permission boundary for narrative candidates. */
export function applyRuntimeStateUpdate(workspace: Record<string, Json>, fields: Record<string, AtomicStateDefinition>,
  active: ReadonlySet<string>, path: string | string[], value: unknown): void {
  const parts = typeof path === 'string' ? path.split('.') : path;
  if (!Array.isArray(parts) || !parts.length || parts.length > 32 || parts.some(part => typeof part !== 'string' || !isSafeStateKey(part)))
    throw new StateValidationError('INVALID_STATE_PATH', 'message', typeof path === 'string' ? path : '');
  const fullPath = parts.join('.');
  if (!active.has(parts[0]!)) throw new StateValidationError('STATE_ROOT_NOT_ACTIVE', 'message', fullPath);
  updateAtomicState(workspace, fields, fullPath, value, 'message');
}
