import { isDeepStrictEqual } from 'node:util';
import {
  isSafeStateKey, STATE_MAX_DEPTH, StateValidationError, validateStateDefinition, validateStateJson,
  validateStateValue, type StateScope,
} from '@sillyrealms/sdk/state-validation';
import type { JsonObject, JsonValue } from '../../infrastructure/database/connection.js';
import type { PreparedStatePatch, StateUpdate } from './types.js';

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function parseStatePath(path: string, scope: StateScope): string[] {
  if (typeof path !== 'string') throw new StateValidationError('INVALID_STATE_PATH', scope);
  const parts = path.split('.');
  if (parts.length > STATE_MAX_DEPTH || parts.some(part => !isSafeStateKey(part))) {
    throw new StateValidationError('INVALID_STATE_PATH', scope, path);
  }
  return parts;
}

/** Read only the selected definition; unrelated roots never gate a field write. */
function definitionFor(state: JsonValue | null, scope: StateScope, root: string): unknown {
  if (state === null) return undefined;
  if (!isObject(state) || state.schema_version !== 2 || !isObject(state.scopes)) {
    throw new StateValidationError('INVALID_STATE', scope, 'state');
  }
  const definitions = state.scopes[scope];
  if (definitions === undefined) return undefined;
  if (!isObject(definitions)) throw new StateValidationError('INVALID_STATE', scope, 'scopes.' + scope);
  return Object.hasOwn(definitions, root) ? definitions[root] : undefined;
}

/** Prepare one replacement without creating paths or validating other state roots. */
export function prepareStatePatch(
  snapshot: JsonObject, state: JsonValue | null, scope: StateScope, update: StateUpdate,
): PreparedStatePatch<JsonObject> {
  const [root, ...nested] = parseStatePath(update.path, scope) as [string, ...string[]];
  const unchanged = { snapshot, changed: false };
  if (!Object.hasOwn(snapshot, root)) return unchanged;

  let current: unknown = snapshot[root];
  for (const part of nested) {
    // Runtime paths address object properties; arrays are replaced as complete values.
    if (Array.isArray(current)) throw new StateValidationError('INVALID_STATE_PATH', scope, update.path);
    if (!isObject(current) || !Object.hasOwn(current, part)) return unchanged;
    current = current[part];
  }

  const definition = definitionFor(state, scope, root);
  if (definition === undefined) return unchanged;
  validateStateDefinition(root, definition, scope);
  validateStateJson(update.value, 0, scope, update.path);
  let replacement: JsonValue;
  if (nested.length === 0) {
    replacement = structuredClone(update.value);
  } else {
    if (definition.type !== 'json') throw new StateValidationError('INVALID_STATE_PATH', scope, update.path);
    replacement = structuredClone(snapshot[root]!);
    let target = replacement as JsonObject;
    for (const part of nested.slice(0, -1)) target = target[part] as JsonObject;
    target[nested[nested.length - 1]!] = structuredClone(update.value);
  }
  // Type, range, JSON bounds and rules coverage apply to this root only.
  validateStateValue(definition, replacement, root, scope);
  if (isDeepStrictEqual(current, update.value)) return unchanged;
  return { snapshot: { ...snapshot, [root]: replacement }, changed: true };
}
