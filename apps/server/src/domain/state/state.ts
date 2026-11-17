import {
  isSafeStateKey, StateValidationError, validateStateSchema,
  type Json, type StateScope,
} from '@sillyrealms/sdk/state-validation';
import { initialAtomicState, validateAtomicJson, validateAtomicSnapshot, validateAtomicValue, type AtomicStateDefinition } from './atomic-state.js';

export type { Json } from '@sillyrealms/sdk/state-validation';
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function definitionsFor(state: unknown, scope: StateScope): Record<string, AtomicStateDefinition> {
  if (state === undefined) return {};
  validateStateSchema(state);
  return state.scopes[scope] ?? {};
}

/** Initialize one scope from a strict v2 definition. An omitted state defines no roots. */
export function initialState(state: unknown, scope: StateScope): Record<string, Json> {
  return initialAtomicState(definitionsFor(state, scope), scope);
}

/** Opening values replace complete message roots; they never merge or supply definitions. */
export function applyOpening(state: unknown, initial: Record<string, Json>, override: unknown): Record<string, Json> {
  const definitions = definitionsFor(state, 'message');
  if (override === undefined) {
    validateAtomicSnapshot(definitions, initial, 'message');
    return initial;
  }
  if (!isObject(override)) throw new StateValidationError('INVALID_STATE_VALUE', 'message', 'opening.initial_state');
  const result = structuredClone(initial);
  for (const [root, value] of Object.entries(override)) {
    if (!isSafeStateKey(root)) throw new StateValidationError('INVALID_STATE_KEY', 'message', root);
    if (!Object.hasOwn(definitions, root) || !Object.hasOwn(result, root)) throw new StateValidationError('STATE_NOT_FOUND', 'message', root);
    validateAtomicValue(definitions[root]!, value, root, 'message');
    result[root] = structuredClone(value);
  }
  validateAtomicSnapshot(definitions, result, 'message');
  return result;
}

export function validateSnapshot(state: unknown, scope: StateScope, value: unknown): asserts value is Record<string, Json> {
  validateAtomicSnapshot(definitionsFor(state, scope), value, scope);
}

export function decodeMessageState(text: string): Record<string, Json> {
  const entries: unknown = JSON.parse(text);
  if (!Array.isArray(entries)) throw new StateValidationError('INVALID_STATE_VALUE', 'message');
  const result: Record<string, Json> = Object.create(null);
  for (const entry of entries) {
    if (!isObject(entry) || typeof entry.key !== 'string' || !Object.hasOwn(entry, 'value'))
      throw new StateValidationError('INVALID_STATE_VALUE', 'message');
    if (!isSafeStateKey(entry.key)) throw new StateValidationError('INVALID_STATE_KEY', 'message', entry.key);
    if (Object.hasOwn(result, entry.key)) throw new StateValidationError('STATE_SCHEMA_MISMATCH', 'message', entry.key);
    validateAtomicJson(entry.value, 0, 'message', entry.key);
    result[entry.key] = entry.value;
  }
  return result;
}
