import { isSafeStateKey, StateValidationError } from '@sillyrealms/sdk/state-validation';
import type { JsonObject, JsonValue } from '../../infrastructure/database/connection.js';

const isObject = (value: JsonValue): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Decode all roots for views, or only the affected root for a field write. */
export function messageValues(entries: JsonValue[] | null, root?: string): JsonObject {
  const values: JsonObject = Object.create(null);
  for (const entry of entries ?? []) {
    if (root !== undefined && (!isObject(entry) || entry.key !== root)) continue;
    if (!isObject(entry) || typeof entry.key !== 'string' || !Object.hasOwn(entry, 'value')) {
      throw new StateValidationError('INVALID_STATE_VALUE', 'message', root ?? '');
    }
    if (!isSafeStateKey(entry.key)) throw new StateValidationError('INVALID_STATE_KEY', 'message', entry.key);
    if (Object.hasOwn(values, entry.key)) throw new StateValidationError('STATE_SCHEMA_MISMATCH', 'message', entry.key);
    values[entry.key] = entry.value!;
  }
  return values;
}

export function replaceMessageValue(entries: JsonValue[], root: string, value: JsonValue): JsonValue[] {
  return entries.map(entry => isObject(entry) && entry.key === root ? { ...entry, value } : entry);
}
