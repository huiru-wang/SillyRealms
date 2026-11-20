import type { JsonObject, JsonValue } from '../../infrastructure/database/connection.js';
import { stateUpdateOutputSchema, type StateUpdateItem } from './output.js';

const record = (value: JsonValue | undefined): JsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
const updateSchema = stateUpdateOutputSchema.shape.updates.element;
const unreadableUpdate = (): StateUpdateItem => ({
  status: 'processing_error', errorCode: 'STATE_UPDATE_STORED_RESULT_INVALID',
});

function readStateUpdate(value: JsonValue): JsonValue {
  const state = record(value);
  if (!state || !Object.hasOwn(state, 'results')) return value;
  const { results, ...output } = state;
  if (!Array.isArray(results) || !Array.isArray(output.updates)) return output;
  // Transitional records that already carry row statuses need no legacy pairing.
  if (output.updates.some(update => record(update)?.status !== undefined)) return output;
  let acceptedIndex = 0;
  const accepted = output.updates;
  const updates = results.map(result => {
    const row = record(result);
    if (row?.status !== 'success') {
      const parsed = updateSchema.safeParse(row);
      return parsed.success ? parsed.data : unreadableUpdate();
    }
    // The old accepted list followed successful results in order, including repeated paths.
    const candidate = record(accepted[acceptedIndex++]);
    const parsed = updateSchema.safeParse({ ...candidate, status: 'success' });
    if (!parsed.success || (row.path !== undefined && row.path !== parsed.data.path)) return unreadableUpdate();
    return parsed.data;
  });
  const status = output.status === 'success' || output.status === 'partial_success' || output.status === 'invalid_updates'
    ? updates.every(update => update.status === 'success') && updates.length > 0 ? 'success'
      : updates.some(update => update.status === 'success') ? 'partial_success' : 'invalid_updates'
    : output.status;
  return { ...output, ...(status === undefined ? {} : { status }), updates };
}

function readActionSuggestions(value: JsonValue): JsonValue {
  const actions = record(value);
  if (!actions || !Object.hasOwn(actions, 'results')) return value;
  const output = { ...actions };
  delete output.results;
  return output;
}

/** Normalize old persisted results only while projecting entries; never rewrite stored history. */
export function readStoredNarrativeOutput(value: JsonValue): JsonValue {
  const output = record(value);
  if (!output) return value;
  return {
    ...output,
    ...(output.stateUpdate !== undefined ? { stateUpdate: readStateUpdate(output.stateUpdate) } : {}),
    ...(output.actionSuggestions !== undefined ? { actionSuggestions: readActionSuggestions(output.actionSuggestions) } : {}),
  };
}
