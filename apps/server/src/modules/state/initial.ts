import { isSafeStateKey, StateValidationError, validateStateJson, validateStateSchema, validateStateValue, type StateSchema } from '@sillyrealms/sdk/state-validation';
import type { JsonObject, JsonValue } from '../../infrastructure/database/connection.js';

/** Initialize local scopes only. Opening overrides replace whole message roots. */
export function prepareInitialSnapshots(definition: JsonValue | null, overrides: unknown) {
  let schema: StateSchema = { schema_version: 2, scopes: {} };
  if (definition !== null) {
    validateStateSchema(definition);
    schema = definition;
  }
  const session: JsonObject = Object.fromEntries(Object.entries(schema.scopes.session ?? {})
    .map(([key, field]) => [key, structuredClone(field.initial)]));
  const message: JsonObject = Object.fromEntries(Object.entries(schema.scopes.message ?? {})
    .map(([key, field]) => [key, structuredClone(field.initial)]));
  if (overrides !== undefined) {
    validateStateJson(overrides);
    if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
      throw new StateValidationError('INVALID_STATE_VALUE', 'message', 'initial_state');
    }
    for (const [key, value] of Object.entries(overrides)) {
      if (!isSafeStateKey(key)) throw new StateValidationError('INVALID_STATE_KEY', 'message', key);
      const field = schema.scopes.message?.[key];
      if (!field) throw new StateValidationError('STATE_NOT_FOUND', 'message', key);
      validateStateValue(field, value, key, 'message');
      message[key] = structuredClone(value);
    }
  }
  return { session, message: Object.entries(message).map(([key, value]) => ({ key, value })) };
}
