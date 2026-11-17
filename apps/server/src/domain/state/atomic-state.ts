import { isDeepStrictEqual } from 'node:util';
import {
  isSafeStateKey, StateValidationError, validateStateDefinition, validateStateJson,
  validateStateSnapshot, validateStateValue,
  type Json, type StateDefinition, type StateDiagnostic, type StateScope, type StateValidationCode,
} from '@sillyrealms/sdk/state-validation';

export type AtomicStateDefinition = StateDefinition;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateAtomicJson(value: unknown, depth = 0, scope: StateScope = 'message', path = ''): asserts value is Json {
  validateStateJson(value, depth, scope, path);
}

export function validateAtomicValue(definition: AtomicStateDefinition, value: unknown, root: string, scope: StateScope = 'message'): asserts value is Json {
  validateStateValue(definition, value, root, scope);
}

/** Replace one root or one property whose parent already exists; publish only a valid copy. */
export function updateAtomicState(
  values: Record<string, Json>, definitions: Record<string, AtomicStateDefinition>, path: string, value: unknown,
  scope: StateScope = 'message',
): { changed: boolean; value: Json } {
  if (typeof path !== 'string') throw new StateValidationError('INVALID_STATE_PATH', scope);
  const parts = path.split('.');
  if (parts.length > 32 || parts.some(part => !isSafeStateKey(part))) throw new StateValidationError('INVALID_STATE_PATH', scope, path);
  const [root, ...nested] = parts;
  if (!root || !Object.hasOwn(definitions, root) || !Object.hasOwn(values, root)) throw new StateValidationError('STATE_NOT_FOUND', scope, path);
  const definition = definitions[root]!;
  if (!nested.length) {
    validateAtomicValue(definition, value, root, scope);
    const changed = !isDeepStrictEqual(values[root], value);
    if (changed) values[root] = structuredClone(value);
    return { changed, value: structuredClone(value) };
  }
  if (definition.type !== 'json') throw new StateValidationError('INVALID_STATE_PATH', scope, path);
  validateAtomicJson(value, 0, scope, path);
  const copy = structuredClone(values[root]);
  let target: unknown = copy;
  for (const part of nested.slice(0, -1)) {
    if (!isObject(target) || !Object.hasOwn(target, part)) throw new StateValidationError('INVALID_STATE_PATH', scope, path);
    target = target[part];
  }
  if (!isObject(target)) throw new StateValidationError('INVALID_STATE_PATH', scope, path);
  const key = nested[nested.length - 1]!;
  const changed = !Object.hasOwn(target, key) || !isDeepStrictEqual(target[key], value);
  if (changed) target[key] = structuredClone(value);
  validateAtomicValue(definition, copy, root, scope);
  if (changed) values[root] = copy as Json;
  return { changed, value: structuredClone(value) };
}

/** Build a scope from its directly declared roots without changing author text. */
export function initialAtomicState(definitions: Record<string, AtomicStateDefinition>, scope: StateScope = 'message'): Record<string, Json> {
  const values: Record<string, Json> = Object.create(null);
  for (const [root, definition] of Object.entries(definitions)) {
    validateStateDefinition(root, definition, scope);
    values[root] = structuredClone(definition.initial);
  }
  return values;
}

/** Validate every declared root, including inactive roots, without mutating a snapshot. */
export function validateAtomicSnapshot(definitions: Record<string, AtomicStateDefinition>, value: unknown, scope: StateScope = 'message'): asserts value is Record<string, Json> {
  validateStateSnapshot(definitions, value, scope);
}

export type AtomicScope = StateScope;
export type AtomicUpdate = { path: string; value: unknown; scope?: AtomicScope };
export type AtomicUpdateResult = {
  path: string; scope: AtomicScope; success: boolean; message: string;
  errorCode?: StateValidationCode; stateDiagnostic?: StateDiagnostic;
};
export type AtomicChange = { path: string; scope: AtomicScope; value: Json };

/** Evaluate updates independently, in input order; caller persists before emitting changes. */
export function applyAtomicUpdates(
  values: Record<AtomicScope, Record<string, Json>>,
  definitions: Record<AtomicScope, Record<string, AtomicStateDefinition>>,
  updates: AtomicUpdate[],
): { values: Record<AtomicScope, Record<string, Json>>; results: AtomicUpdateResult[]; changes: AtomicChange[] } {
  const working = structuredClone(values);
  const results: AtomicUpdateResult[] = [];
  const paths: Array<{ path:string; scope:AtomicScope }> = [];
  for (const update of updates) {
    const scope = update.scope ?? 'message';
    try {
      const result = updateAtomicState(working[scope], definitions[scope], update.path, update.value, scope);
      results.push({ path:update.path, scope, success:true, message:'' });
      if (result.changed && !paths.some(item => item.path === update.path && item.scope === scope)) paths.push({ path:update.path, scope });
    } catch (error) {
      results.push({
        path:update.path, scope, success:false,
        message:error instanceof Error ? error.message : 'INVALID_STATE_UPDATE',
        ...(error instanceof StateValidationError ? { errorCode:error.code, stateDiagnostic:error.details } : {}),
      });
    }
  }
  // Publish only values present in the final snapshot, never intermediate writes.
  const lookup = (source: Record<string, Json>, path: string): { found:boolean; value?:Json } => {
    let current: unknown = source;
    for (const part of path.split('.')) {
      if (!isObject(current) || !Object.hasOwn(current, part)) return { found:false };
      current = current[part];
    }
    return { found:true, value:current as Json };
  };
  const changes: AtomicChange[] = [];
  for (const item of paths) {
    const before = lookup(values[item.scope], item.path);
    const after = lookup(working[item.scope], item.path);
    if (after.found && (!before.found || !isDeepStrictEqual(before.value, after.value))) changes.push({ ...item, value:structuredClone(after.value!) });
  }
  return { values:working, results, changes };
}
