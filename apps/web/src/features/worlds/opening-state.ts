import {isSafeStateKey, StateValidationError, validateStateSchema, validateStateValue, type Json, type StateDefinition} from '@sillyrealms/sdk/state-validation';

export type Row = {name: string; value: Json; overridden: boolean};
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** Preview uses the same v2 definition and complete-root checks as the server. */
export function openingStateRows(state: unknown, override: unknown): Row[] {
  let definitions: Record<string, StateDefinition> = {};
  if (state !== undefined) {
    validateStateSchema(state);
    definitions = state.scopes.message ?? {};
  }
  if (override !== undefined && !object(override)) throw new StateValidationError('INVALID_STATE_VALUE', 'message', 'opening.initial_state');
  const overrides = override === undefined ? {} : override as Record<string, unknown>;
  for (const name of Object.keys(overrides)) {
    if (!isSafeStateKey(name)) throw new StateValidationError('INVALID_STATE_KEY', 'message', name);
    if (!Object.hasOwn(definitions, name)) throw new StateValidationError('STATE_NOT_FOUND', 'message', name);
  }
  return Object.entries(definitions).map(([name, definition]) => {
    const overridden = Object.hasOwn(overrides, name);
    const value = overridden ? overrides[name] : definition.initial;
    validateStateValue(definition, value, name, 'message');
    return {name, value, overridden};
  });
}
